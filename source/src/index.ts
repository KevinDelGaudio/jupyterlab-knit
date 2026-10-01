import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  Dialog,
  ICommandPalette,
  MainAreaWidget,
  Notification,
  showDialog
} from '@jupyterlab/apputils';
import { PageConfig, PathExt, URLExt } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { Kernel, KernelAPI } from '@jupyterlab/services';
import { IStateDB } from '@jupyterlab/statedb';
import {
  CommandToolbarButton,
  MenuSvg,
  stopIcon
} from '@jupyterlab/ui-components';
import { Widget } from '@lumino/widgets';

import { WIDE_TABLES_FILE, WIDE_TABLES_LUA } from './filters';
import {
  ControlChannel,
  IActiveKnit,
  RENDER_SESSION,
  TASK_SESSION,
  busyRenderSessions,
  cleanupStaleHelpers,
  errorMessage,
  parseMarker,
  runHelper,
  withArgs,
  withControl
} from './runner';
import { CLEAR_CACHE_SCRIPT, RENDER_SCRIPT } from './scripts';
import {
  ActiveKnitsPanel,
  KnitButton,
  RenderLog,
  formatLabel,
  yarnIcon
} from './ui';
import { defaultFormat, newHeader, promoteFormat } from './yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_KEY = 'jupyterlab-knit:directories';

const CMD = {
  knit: 'knit:knit',
  knitTo: 'knit:knit-to',
  params: 'knit:knit-with-parameters',
  directory: 'knit:directory',
  active: 'knit:active-knits',
  clearCache: 'knit:clear-cache',
  stop: 'knit:stop',
  showLog: 'knit:show-render-log'
};

type KnitDirectory = 'document' | 'project';

const DIRECTORY_LABELS: { [dir: string]: string } = {
  document: 'Document Directory',
  project: 'Project Directory'
};

// ---------------------------------------------------------------------------
// Notebook helpers
// ---------------------------------------------------------------------------

/** The first cell, if it is a raw cell holding a YAML header. */
function headerSource(panel: NotebookPanel): string | null {
  const cells = panel.content.model?.cells;
  if (!cells || cells.length === 0) {
    return null;
  }
  const first = cells.get(0);
  if (first.type !== 'raw') {
    return null;
  }
  const src = first.sharedModel.getSource();
  return src.trimStart().startsWith('---') ? src : null;
}

function knitFormat(panel: NotebookPanel): string {
  const src = headerSource(panel);
  return (src !== null ? defaultFormat(src) : null) ?? 'html';
}

/**
 * Make `format` the first one in the header, creating the header if needed,
 * so the Knit button keeps using it (RStudio rewrites `output:` the same way).
 */
function setDefaultFormat(panel: NotebookPanel, format: string): void {
  const model = panel.content.model;
  if (!model) {
    return;
  }
  const src = headerSource(panel);
  if (src === null) {
    if (format !== 'html') {
      model.sharedModel.insertCell(0, {
        cell_type: 'raw',
        source: newHeader(format)
      });
    }
    return;
  }
  const updated = promoteFormat(src, format);
  if (updated !== null) {
    model.cells.get(0).sharedModel.setSource(updated);
  }
}

interface IParam {
  name: string;
  value: string;
}

/** Assignments in the cell tagged "parameters" (papermill convention). */
function readParameters(panel: NotebookPanel): IParam[] | null {
  const cells = panel.content.model?.cells;
  if (!cells) {
    return null;
  }
  for (let i = 0; i < cells.length; i++) {
    const cell = cells.get(i);
    const tags = (cell.getMetadata('tags') as string[] | undefined) ?? [];
    if (!tags.includes('parameters')) {
      continue;
    }
    const params: IParam[] = [];
    for (const line of cell.sharedModel.getSource().split('\n')) {
      const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*$/);
      if (m) {
        params.push({ name: m[1], value: m[2].replace(/\s+#.*$/, '') });
      }
    }
    return params;
  }
  return null;
}

function filesUrl(path: string, download: boolean): string {
  const url = URLExt.join(PageConfig.getBaseUrl(), 'files', URLExt.encodeParts(path));
  return download ? url + '?download=1' : url;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-knit:plugin',
  description: 'RStudio-style Knit button for notebooks, rendered with Quarto.',
  autoStart: true,
  requires: [INotebookTracker, IDocumentManager],
  optional: [ICommandPalette, IStateDB],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    docManager: IDocumentManager,
    palette: ICommandPalette | null,
    state: IStateDB | null
  ) => {
    const { commands } = app;
    const sessions = app.serviceManager.sessions;

    // ---- state ------------------------------------------------------------
    // the render started from this page, if any
    let localRun: { nbPath: string; kernel: Kernel.IKernelConnection | null } | null = null;
    let directories: { [path: string]: KnitDirectory } = {};

    if (state) {
      state
        .fetch(STATE_KEY)
        .then(value => {
          if (value) {
            directories = value as { [path: string]: KnitDirectory };
          }
        })
        .catch(err => console.warn('jupyterlab-knit: could not read state', err));
    }

    const directoryOf = (path: string): KnitDirectory =>
      directories[path] ?? 'document';

    const refreshCommands = () => {
      commands.notifyCommandChanged(CMD.stop);
      commands.notifyCommandChanged(CMD.active);
    };
    sessions.runningChanged.connect(refreshCommands);

    // helper sessions left behind by closed or reloaded pages
    void app.restored.then(() => cleanupStaleHelpers(app, new Set()));

    // ---- render pane ------------------------------------------------------
    const log = new RenderLog();
    const pane = new MainAreaWidget({ content: log });
    pane.id = 'jupyterlab-knit-render';
    pane.title.label = 'Render';
    pane.title.icon = yarnIcon;
    pane.title.closable = true;
    pane.toolbar.addItem(
      'stop',
      new CommandToolbarButton({ commands, id: CMD.stop, icon: stopIcon })
    );

    const showPane = () => {
      if (!pane.isAttached) {
        app.shell.add(pane, 'down');
      }
      app.shell.activateById(pane.id);
    };

    // ---- preview ----------------------------------------------------------
    const preview = async (path: string) => {
      const ext = PathExt.extname(path).toLowerCase();
      const factory = ext === '.html' ? 'HTML Viewer' : ext === '.pdf' ? 'PDF' : null;
      if (!factory) {
        return;
      }
      const existing = docManager.findWidget(path, factory);
      if (existing) {
        await existing.context.revert();
        docManager.openOrReveal(path, factory);
      } else {
        docManager.open(path, factory, undefined, { mode: 'split-right' });
      }
    };

    // ---- active knits -----------------------------------------------------
    const isLocal = (knit: IActiveKnit) =>
      localRun !== null &&
      localRun.kernel !== null &&
      knit.kernel_id === localRun.kernel.id;

    /**
     * Stop one render. One started from this page is stopped by interrupting
     * its helper kernel, so this page gets the usual "stopped" report; any
     * other is stopped through the registry, which also cleans up after it.
     */
    const stopKnit = async (channel: ControlChannel, knit: IActiveKnit) => {
      if (isLocal(knit) && localRun?.kernel) {
        await localRun.kernel.interrupt();
        return 'stopping';
      }
      const status = await channel.stop(knit.id);
      // the helper that launched it belonged to a page that is gone or that
      // will shut it down itself; only an idle orphan is shut down here
      await shutdownHelperOf(knit);
      return status;
    };

    /**
     * Shut down the helper session that launched a render stopped from
     * elsewhere, once it has finished its own clean-up (it stays busy for a
     * moment after the render ends). A page still showing that render shuts
     * the session down itself; doing it twice is harmless.
     */
    const shutdownHelperOf = async (knit: IActiveKnit) => {
      if (!knit.kernel_id) {
        return;
      }
      try {
        await sessions.refreshRunning();
        const model = [...sessions.running()].find(m => m.kernel?.id === knit.kernel_id);
        if (!model) {
          return;
        }
        // the session list caches kernel states; ask the server directly
        for (let attempt = 0; attempt < 20; attempt++) {
          const kernel = await KernelAPI.getKernelModel(
            knit.kernel_id,
            app.serviceManager.serverSettings
          );
          if (!kernel || kernel.execution_state !== 'busy') {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        await sessions.shutdown(model.id);
      } catch (err) {
        console.warn('jupyterlab-knit: could not shut down a helper session', err);
      }
    };

    const showActiveKnits = async () => {
      void cleanupStaleHelpers(app, new Set());
      const channel = new ControlChannel(app);
      const panel = new ActiveKnitsPanel({
        list: () => channel.list(),
        stop: knit => stopKnit(channel, knit),
        isLocal
      });
      try {
        await showDialog({
          title: 'Active Knits',
          body: panel,
          buttons: [Dialog.okButton({ label: 'Close' })]
        });
      } finally {
        panel.dispose();
        await channel.dispose();
        refreshCommands();
      }
    };

    const activeKnitsAction = {
      label: 'Active knits',
      callback: () => void showActiveKnits()
    };

    // ---- knit -------------------------------------------------------------
    const showLogAction = {
      label: 'Show render log',
      callback: () => showPane()
    };

    /**
     * Render the notebook and report the outcome in `id`. Returns the output
     * path on success, null after a failure or a stop has been reported.
     */
    const render = async (
      panel: NotebookPanel,
      params: string[],
      format: string,
      id: string
    ): Promise<{ output: string; engine: string } | null> => {
      const nbPath = panel.context.path;
      const nbDir = PathExt.dirname(nbPath);

      const fail = (message: string, details?: string) => {
        if (details) {
          log.writeLine(details);
        }
        log.writeLine(`ERROR: ${message}`);
        Notification.update({
          id,
          type: 'error',
          message: `Knit failed: ${message}`,
          autoClose: false,
          actions: [showLogAction]
        });
        return null;
      };
      const stopped = () => {
        log.writeLine('Render stopped.');
        Notification.update({
          id,
          type: 'warning',
          message: `Knit stopped: ${nbPath}`,
          autoClose: 4000
        });
        return null;
      };

      try {
        await panel.context.save();
      } catch (err) {
        return fail(`could not save the notebook (${errorMessage(err)})`);
      }

      const projectDepth =
        directoryOf(nbPath) === 'project'
          ? nbDir === ''
            ? 0
            : nbDir.split('/').length
          : null;
      const code = withArgs(RENDER_SCRIPT, {
        nb: PathExt.basename(nbPath),
        nb_path: nbPath,
        to: format,
        params,
        project_depth: projectDepth,
        filter_name: WIDE_TABLES_FILE,
        filter_lua: WIDE_TABLES_LUA
      });

      let run;
      try {
        run = await runHelper(app, {
          dir: nbDir,
          code,
          type: RENDER_SESSION,
          onText: text => log.write(text),
          onKernel: kernel => {
            if (localRun) {
              localRun.kernel = kernel;
            }
            refreshCommands();
          }
        });
      } catch (err) {
        // The helper kernel could not start, or died or restarted while
        // rendering. A render it had launched may still be running unseen:
        // stop it through the registry so nothing is left behind.
        let note = '';
        try {
          const leftover = await withControl(app, async channel => {
            const mine = (await channel.list()).filter(k => k.notebook === nbPath);
            for (const knit of mine) {
              await channel.stop(knit.id);
            }
            return mine.length;
          });
          if (leftover > 0) {
            note = ' The render it had started was stopped.';
          }
        } catch (cleanupErr) {
          note = ` Check Active Knits for a leftover render (${errorMessage(cleanupErr)}).`;
        }
        return fail(
          `the helper kernel crashed or was shut down.${note}`,
          `Helper kernel error: ${errorMessage(err)}`
        );
      }

      if (run.error) {
        // the script itself raised; a stop before it could handle it lands here
        if (run.error.startsWith('KeyboardInterrupt')) {
          return stopped();
        }
        return fail(`internal error: ${run.error}`, run.traceback);
      }

      const result = parseMarker(run.stdout);
      if (!result) {
        return fail('the helper kernel returned no result');
      }
      if (result.cancelled) {
        return stopped();
      }
      if (result.busy) {
        log.writeLine(`ERROR: ${result.summary}`);
        Notification.update({
          id,
          type: 'warning',
          message: `Not started: ${result.summary}`,
          autoClose: false,
          actions: [activeKnitsAction]
        });
        return null;
      }
      if (result.rc !== 0 || !result.output) {
        return fail(`(${result.engine}) ${result.summary}`);
      }

      const output = PathExt.join(nbDir, result.output);
      const ext = PathExt.extname(output).toLowerCase();
      const viewable = ext === '.html' || ext === '.pdf';
      Notification.update({
        id,
        type: 'success',
        message: `Knitted to ${formatLabel(format)} with ${result.engine}: ${output}`,
        autoClose: 6000,
        actions: [
          viewable
            ? {
                label: 'Open in browser tab',
                callback: () => window.open(filesUrl(output, false), '_blank')
              }
            : {
                label: 'Download',
                callback: () => window.open(filesUrl(output, true), '_blank')
              }
        ]
      });
      return { output, engine: result.engine };
    };

    const knit = async (panel: NotebookPanel, params: string[]) => {
      const nbPath = panel.context.path;
      if (localRun) {
        Notification.warning(
          `This tab is already knitting ${localRun.nbPath}; stop it or wait.`,
          { autoClose: 5000 }
        );
        return;
      }
      localRun = { nbPath, kernel: null };
      refreshCommands();

      const format = knitFormat(panel);
      log.clear();
      showPane();
      const id = Notification.emit(
        `Knitting ${nbPath} to ${formatLabel(format)}…`,
        'in-progress',
        { autoClose: false }
      );

      let outcome: { output: string; engine: string } | null = null;
      try {
        outcome = await render(panel, params, format, id);
      } catch (err) {
        // anything not handled above is a bug; report it rather than hang
        log.writeLine(`ERROR: unexpected failure: ${errorMessage(err)}`);
        Notification.update({
          id,
          type: 'error',
          message: `Knit failed unexpectedly: ${errorMessage(err)}`,
          autoClose: false,
          actions: [showLogAction, activeKnitsAction]
        });
      } finally {
        localRun = null;
        refreshCommands();
      }

      // a failing preview must not turn a successful knit into a failure
      if (outcome) {
        try {
          await preview(outcome.output);
        } catch (err) {
          Notification.warning(
            `Knitted ${outcome.output}, but it could not be previewed: ${errorMessage(err)}`,
            { autoClose: 8000 }
          );
        }
      }
    };

    // ---- commands -----------------------------------------------------------
    const panelFor = (args: any): NotebookPanel | null => {
      if (args && args.panelId) {
        return tracker.find(p => p.id === args.panelId) ?? null;
      }
      return tracker.currentWidget;
    };

    commands.addCommand(CMD.knit, {
      label: 'Knit',
      caption: 'Knit with the first format in the header (HTML if none)',
      isEnabled: args => panelFor(args) !== null,
      execute: async args => {
        const panel = panelFor(args);
        if (panel) {
          await knit(panel, []);
        }
      }
    });

    commands.addCommand(CMD.knitTo, {
      label: args => `Knit to ${formatLabel(String(args.format ?? 'html'))}`,
      isEnabled: args => panelFor(args) !== null,
      execute: async args => {
        const panel = panelFor(args);
        if (!panel) {
          return;
        }
        setDefaultFormat(panel, String(args.format ?? 'html'));
        await knit(panel, []);
      }
    });

    commands.addCommand(CMD.params, {
      label: 'Knit with Parameters…',
      isEnabled: args => panelFor(args) !== null,
      execute: async args => {
        const panel = panelFor(args);
        if (!panel) {
          return;
        }
        const params = readParameters(panel);
        if (params === null || params.length === 0) {
          await showDialog({
            title: 'Knit with Parameters',
            body:
              'No parameters found. Tag the cell that assigns them with ' +
              '"parameters" (Property Inspector, Cell Tags), e.g. alpha = 0.05.',
            buttons: [Dialog.okButton()]
          });
          return;
        }

        const form = document.createElement('div');
        form.className = 'jp-knit-params';
        const inputs: HTMLInputElement[] = [];
        for (const p of params) {
          const label = document.createElement('label');
          label.textContent = p.name;
          const input = document.createElement('input');
          input.className = 'jp-mod-styled';
          input.value = p.value;
          label.appendChild(input);
          form.appendChild(label);
          inputs.push(input);
        }

        const result = await showDialog({
          title: 'Knit with Parameters',
          body: new Widget({ node: form }),
          buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Knit' })]
        });
        if (!result.button.accept) {
          return;
        }
        const empty = params.filter((_, i) => inputs[i].value.trim() === '');
        if (empty.length > 0) {
          Notification.error(
            `Parameter${empty.length > 1 ? 's' : ''} without a value: ` +
              empty.map(p => p.name).join(', '),
            { autoClose: 6000 }
          );
          return;
        }
        const values = params.map((p, i) => `${p.name}:${inputs[i].value.trim()}`);
        await knit(panel, values);
      }
    });

    commands.addCommand(CMD.directory, {
      label: args => DIRECTORY_LABELS[String(args.dir)] ?? String(args.dir),
      isToggled: args => {
        const panel = panelFor(args);
        return panel !== null && directoryOf(panel.context.path) === args.dir;
      },
      execute: args => {
        const panel = panelFor(args);
        if (!panel) {
          return;
        }
        directories[panel.context.path] = args.dir as KnitDirectory;
        if (state) {
          state
            .save(STATE_KEY, directories)
            .catch(err => console.warn('jupyterlab-knit: could not save state', err));
        }
      }
    });

    commands.addCommand(CMD.active, {
      label: () => {
        const count = Math.max(busyRenderSessions(app), localRun ? 1 : 0);
        return count > 0 ? `Active Knits (${count})…` : 'Active Knits…';
      },
      caption: 'List every running knit and stop any of them',
      execute: () => showActiveKnits()
    });

    commands.addCommand(CMD.clearCache, {
      label: 'Clear Knit Cache…',
      isEnabled: args => panelFor(args) !== null,
      execute: async args => {
        const panel = panelFor(args);
        if (!panel) {
          return;
        }
        const nbDir = PathExt.dirname(panel.context.path);
        const answer = await showDialog({
          title: 'Clear Knit Cache',
          body:
            'Delete the execution cache (.jupyter_cache) in ' +
            `"${nbDir || '/'}"? Cached cells will be recomputed on the next knit.`,
          buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Clear' })]
        });
        if (!answer.button.accept) {
          return;
        }
        try {
          const run = await runHelper(app, {
            dir: nbDir,
            code: CLEAR_CACHE_SCRIPT,
            type: TASK_SESSION
          });
          if (run.error) {
            throw new Error(run.error);
          }
          const result = parseMarker(run.stdout);
          if (!result) {
            throw new Error('no result from the helper kernel');
          }
          if (result.error) {
            throw new Error(result.error);
          }
          Notification.info(
            result.status === 'cleared'
              ? `Knit cache cleared in ${result.dir}`
              : `No knit cache found in ${result.dir}`,
            { autoClose: 4000 }
          );
        } catch (err) {
          Notification.error(`Clearing the cache failed: ${errorMessage(err)}`, {
            autoClose: false
          });
        }
      }
    });

    commands.addCommand(CMD.stop, {
      label: 'Stop Render',
      caption: 'Stop the render of this notebook, wherever it was started',
      isEnabled: () => localRun !== null || busyRenderSessions(app) > 0,
      execute: async () => {
        // a render started from this page
        if (localRun) {
          if (localRun.kernel) {
            try {
              await localRun.kernel.interrupt();
            } catch (err) {
              Notification.error(`Could not stop the render: ${errorMessage(err)}`, {
                autoClose: false,
                actions: [activeKnitsAction]
              });
            }
          }
          return;
        }
        // nothing running here: renders of the current notebook started
        // from another tab or before a reload
        const nbPath = tracker.currentWidget?.context.path ?? null;
        try {
          const stoppedCount = await withControl(app, async channel => {
            const mine = (await channel.list()).filter(k => k.notebook === nbPath);
            for (const knit of mine) {
              await stopKnit(channel, knit);
            }
            return mine.length;
          });
          if (stoppedCount > 0) {
            Notification.info(`Stopped the knit of ${nbPath}`, { autoClose: 4000 });
          } else {
            await showActiveKnits();
          }
        } catch (err) {
          Notification.error(`Could not stop the render: ${errorMessage(err)}`, {
            autoClose: false,
            actions: [activeKnitsAction]
          });
        } finally {
          refreshCommands();
        }
      }
    });

    commands.addCommand(CMD.showLog, {
      label: 'Show Render Log',
      execute: () => showPane()
    });

    commands.addKeyBinding({
      command: CMD.knit,
      keys: ['Accel Shift K'],
      selector: '.jp-Notebook'
    });

    if (palette) {
      const category = 'Knit';
      palette.addItem({ command: CMD.knit, category });
      for (const format of ['html', 'pdf', 'docx']) {
        palette.addItem({ command: CMD.knitTo, args: { format }, category });
      }
      palette.addItem({ command: CMD.params, category });
      palette.addItem({ command: CMD.active, category });
      palette.addItem({ command: CMD.stop, category });
      palette.addItem({ command: CMD.clearCache, category });
      palette.addItem({ command: CMD.showLog, category });
    }

    // ---- dropdown menu ----------------------------------------------------
    const buildMenu = (panel: NotebookPanel): MenuSvg => {
      const panelId = panel.id;
      sessions
        .refreshRunning()
        .then(refreshCommands)
        .catch(err => console.warn('jupyterlab-knit: could not list sessions', err));
      const menu = new MenuSvg({ commands });
      menu.addClass('jp-knit-menu');
      for (const format of ['html', 'pdf', 'docx']) {
        menu.addItem({ command: CMD.knitTo, args: { format, panelId } });
      }
      menu.addItem({ type: 'separator' });
      menu.addItem({ command: CMD.params, args: { panelId } });
      menu.addItem({ type: 'separator' });

      const dirMenu = new MenuSvg({ commands });
      dirMenu.title.label = 'Knit Directory';
      for (const dir of ['document', 'project']) {
        dirMenu.addItem({ command: CMD.directory, args: { dir, panelId } });
      }
      menu.addItem({ type: 'submenu', submenu: dirMenu });

      menu.addItem({ type: 'separator' });
      menu.addItem({ command: CMD.active });
      menu.addItem({ command: CMD.clearCache, args: { panelId } });

      menu.aboutToClose.connect(() => {
        requestAnimationFrame(() => {
          dirMenu.dispose();
          menu.dispose();
        });
      });
      return menu;
    };

    const tooltip = (panel: NotebookPanel) =>
      `Knit to ${formatLabel(knitFormat(panel))} (Ctrl+Shift+K)`;

    tracker.widgetAdded.connect((_, panel) => {
      panel.toolbar.insertItem(
        10,
        'knit',
        new KnitButton(commands, CMD.knit, panel, buildMenu, tooltip)
      );
    });
  }
};

export default plugin;

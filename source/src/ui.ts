import { NotebookPanel } from '@jupyterlab/notebook';
import { caretDownIcon, LabIcon } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import { Message } from '@lumino/messaging';
import { Menu, Widget } from '@lumino/widgets';

import { IActiveKnit, errorMessage, stripAnsi } from './runner';

export const yarnIcon = new LabIcon({
  name: 'jupyterlab-knit:yarn',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">
  <g class="jp-icon3" stroke="#616161" stroke-width="1.6" stroke-linecap="round" style="fill: none">
    <circle cx="11" cy="11" r="7.5"/>
    <path d="M4.5 8c4 .5 8.5 3.5 10.5 9.5"/>
    <path d="M9.5 3.7c-1.5 4.5 0 9.5 4.5 14"/>
    <path d="M16.8 6c-3 2.7-7.5 3.8-12.3 3"/>
    <path d="M16.5 16.5c1.8 1.8 3.8 3 6 3"/>
  </g>
</svg>`
});

const FORMAT_LABELS: { [format: string]: string } = {
  html: 'HTML',
  pdf: 'PDF',
  docx: 'Word'
};

export function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format.toUpperCase();
}

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Render pane: live log of the current render
// ---------------------------------------------------------------------------

export class RenderLog extends Widget {
  private pre: HTMLPreElement;
  private done: string[] = [];
  private current = '';

  constructor() {
    super();
    this.addClass('jp-knit-log');
    this.pre = document.createElement('pre');
    this.node.appendChild(this.pre);
  }

  clear(): void {
    this.done = [];
    this.current = '';
    this.pre.textContent = '';
  }

  /** Append text; carriage returns overwrite the line, as in a terminal. */
  write(text: string): void {
    const parts = stripAnsi(text).split(/(\r\n|\n|\r)/);
    for (const part of parts) {
      if (part === '\n' || part === '\r\n') {
        this.done.push(this.current);
        this.current = '';
      } else if (part === '\r') {
        this.current = '';
      } else {
        this.current += part;
      }
    }
    this.pre.textContent = this.done.join('\n') + '\n' + this.current;
    this.node.scrollTop = this.node.scrollHeight;
  }

  /** Append a message on a line of its own. */
  writeLine(text: string): void {
    const separator = this.current === '' ? '' : '\n';
    this.write(`${separator}${text}\n`);
  }
}

// ---------------------------------------------------------------------------
// Toolbar split button: [yarn Knit][▾]
// ---------------------------------------------------------------------------

export class KnitButton extends Widget {
  constructor(
    commands: CommandRegistry,
    knitCommand: string,
    panel: NotebookPanel,
    buildMenu: (panel: NotebookPanel) => Menu,
    tooltip: (panel: NotebookPanel) => string
  ) {
    super();
    this.addClass('jp-knit-split');

    const main = document.createElement('button');
    main.className = 'jp-knit-main';
    main.appendChild(yarnIcon.element({ tag: 'span', className: 'jp-knit-icon' }));
    const label = document.createElement('span');
    label.textContent = 'Knit';
    main.appendChild(label);
    main.addEventListener('mouseenter', () => {
      main.title = tooltip(panel);
    });
    main.addEventListener('click', () => {
      void commands.execute(knitCommand, { panelId: panel.id });
    });

    const caret = document.createElement('button');
    caret.className = 'jp-knit-caret';
    caret.title = 'Knit options';
    caret.appendChild(caretDownIcon.element({ tag: 'span' }));
    caret.addEventListener('click', () => {
      const menu = buildMenu(panel);
      const rect = caret.getBoundingClientRect();
      menu.open(rect.left, rect.bottom);
    });

    this.node.appendChild(main);
    this.node.appendChild(caret);
  }
}

// ---------------------------------------------------------------------------
// Active Knits: every render running for this user, with Stop buttons
// ---------------------------------------------------------------------------

export interface IActiveKnitsSource {
  list(): Promise<IActiveKnit[]>;
  stop(knit: IActiveKnit): Promise<string>;
  isLocal(knit: IActiveKnit): boolean;
}

const POLL_MS = 2000;

export class ActiveKnitsPanel extends Widget {
  private table: HTMLTableSectionElement;
  private status: HTMLDivElement;
  private stopAll: HTMLButtonElement;
  private timer: number | null = null;
  private knits: IActiveKnit[] = [];
  private stopping = new Set<string>();
  private refreshing = false;

  constructor(private source: IActiveKnitsSource) {
    super();
    this.addClass('jp-knit-active');

    const table = document.createElement('table');
    const head = document.createElement('thead');
    head.innerHTML =
      '<tr><th>Notebook</th><th>Format</th><th>Engine</th>' +
      '<th>Running</th><th>Started from</th><th></th></tr>';
    this.table = document.createElement('tbody');
    table.appendChild(head);
    table.appendChild(this.table);

    this.status = document.createElement('div');
    this.status.className = 'jp-knit-active-status';
    this.status.textContent = 'Looking for active knits…';

    this.stopAll = document.createElement('button');
    this.stopAll.className = 'jp-mod-styled jp-mod-warn';
    this.stopAll.textContent = 'Stop all';
    this.stopAll.disabled = true;
    this.stopAll.addEventListener('click', () => {
      for (const knit of this.knits) {
        void this.stopOne(knit);
      }
    });

    const footer = document.createElement('div');
    footer.className = 'jp-knit-active-footer';
    footer.appendChild(this.status);
    footer.appendChild(this.stopAll);

    this.node.appendChild(table);
    this.node.appendChild(footer);
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  protected onBeforeDetach(msg: Message): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    super.onBeforeDetach(msg);
  }

  dispose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    super.dispose();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || this.isDisposed) {
      return;
    }
    this.refreshing = true;
    try {
      this.knits = await this.source.list();
      this.render(null);
    } catch (err) {
      this.render(`Could not list active knits: ${errorMessage(err)}`);
    } finally {
      this.refreshing = false;
    }
  }

  private async stopOne(knit: IActiveKnit): Promise<void> {
    if (this.stopping.has(knit.id)) {
      return;
    }
    this.stopping.add(knit.id);
    this.render(null);
    try {
      await this.source.stop(knit);
    } catch (err) {
      this.render(`Stopping ${knit.notebook} failed: ${errorMessage(err)}`);
    } finally {
      this.stopping.delete(knit.id);
      await this.refresh();
    }
  }

  private render(error: string | null): void {
    if (this.isDisposed) {
      return;
    }
    this.table.textContent = '';
    for (const knit of this.knits) {
      const row = document.createElement('tr');
      const cells = [
        knit.notebook,
        formatLabel(knit.format),
        knit.engine,
        formatElapsed(knit.elapsed),
        this.source.isLocal(knit) ? 'this tab' : 'another tab or a reloaded page'
      ];
      for (const text of cells) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.appendChild(cell);
      }
      const action = document.createElement('td');
      const button = document.createElement('button');
      button.className = 'jp-mod-styled jp-mod-warn';
      const busy = this.stopping.has(knit.id);
      button.textContent = busy ? 'Stopping…' : 'Stop';
      button.disabled = busy;
      button.addEventListener('click', () => void this.stopOne(knit));
      action.appendChild(button);
      row.appendChild(action);
      this.table.appendChild(row);
    }

    const count = this.knits.length;
    this.stopAll.disabled = count === 0 || this.stopping.size >= count;
    if (error) {
      this.status.textContent = error;
      this.status.classList.add('jp-knit-active-error');
    } else {
      this.status.classList.remove('jp-knit-active-error');
      this.status.textContent =
        count === 0 ? 'No knits running.' : `${count} knit${count === 1 ? '' : 's'} running.`;
    }
  }
}

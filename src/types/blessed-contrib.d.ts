declare module 'blessed-contrib' {
  import * as blessed from 'blessed';

  interface GridOptions {
    rows: number;
    cols: number;
    screen: blessed.Widgets.Screen;
  }

  class grid {
    constructor(options: GridOptions);
    set(
      row: number,
      col: number,
      rowSpan: number,
      colSpan: number,
      widget: any,
      options?: any
    ): any;
  }

  interface LineOptions {
    label?: string;
    showLegend?: boolean;
    style?: {
      line?: string;
      text?: string;
      baseline?: string;
      border?: { fg?: string };
    };
  }

  interface LineData {
    title?: string;
    x: string[];
    y: number[];
    style?: { line?: string };
  }

  class line {
    constructor(options?: LineOptions);
    setData(data: LineData[]): void;
  }

  interface TableOptions {
    label?: string;
    keys?: boolean;
    fg?: string;
    columnSpacing?: number;
    columnWidth?: number[];
    style?: {
      border?: { fg?: string };
      header?: { fg?: string; bold?: boolean };
      cell?: { fg?: string };
    };
  }

  interface TableData {
    headers: string[];
    data: string[][];
  }

  class table {
    constructor(options?: TableOptions);
    setData(data: TableData): void;
  }

  interface LogOptions {
    label?: string;
    fg?: string;
    selectedFg?: string;
    tags?: boolean;
    border?: { type?: string };
    style?: {
      border?: { fg?: string };
    };
  }

  class log {
    constructor(options?: LogOptions);
    log(message: string): void;
  }

  export { grid, line, table, log };
}

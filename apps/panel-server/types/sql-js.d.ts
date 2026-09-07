declare module "sql.js" {
  export interface Statement {
    bind(params?: unknown[]): void;
    step(): boolean;
    reset(): void;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  export interface QueryResult {
    columns: string[];
    values: unknown[][];
  }

  export interface Database {
    exec(sql: string): QueryResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    getRowsModified(): number;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | ArrayBuffer) => Database;
  }

  export interface InitSqlJsConfig {
    locateFile: (file: string) => string;
  }

  function initSqlJs(config: InitSqlJsConfig): Promise<SqlJsStatic>;
  export default initSqlJs;
}

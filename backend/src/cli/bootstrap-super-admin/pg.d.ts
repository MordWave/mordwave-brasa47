// `pg` ships no types and @types/pg is not a dependency of this project (and this tool does not justify adding one): this is
// the minimal surface the bootstrap CLI uses.
declare module 'pg' {
  export interface ClientConfig {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    ssl?: boolean | { rejectUnauthorized: boolean };
    application_name?: string;
    connectionTimeoutMillis?: number;
    statement_timeout?: number;
    query_timeout?: number;
  }
  export class Client {
    constructor(config: ClientConfig);
    connect(): Promise<void>;
    end(): Promise<void>;
    query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
  const pg: { Client: typeof Client };
  export default pg;
}

// Vite `?raw` imports used by tests to load SQL fixtures.
declare module "*.ts?raw" {
  const source: string;
  export default source;
}

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

// Vite's `import.meta.glob`, used by tests that read the API's own source as text.
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}

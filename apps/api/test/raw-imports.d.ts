// Vite `?raw` imports used by tests to load SQL fixtures.
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

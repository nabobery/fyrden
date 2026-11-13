// Vite's `?raw` imports (used for workflow fixtures): the file's text.
declare module "*?raw" {
  const text: string;
  export default text;
}

import { createApp } from "./app.js";

/** The one app both entrypoints serve: the Worker's own fetch, and fyrden-web's service binding. */
export const app = createApp();

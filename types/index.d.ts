/** The images pasted with one prompt, keyed by the prompt's text without its [Image #N] tags. */
export type Pasted = { key: string; files: string[] }

declare module 'claude-code' {
  interface PluginState {
    'inline-images': { pasted: Shaped<Pasted[]> }
  }
}

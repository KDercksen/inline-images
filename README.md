# inline-images

A Claude Code mod that draws images inline in the terminal transcript, with no command to run:

- images pasted into a prompt, under that prompt's row;
- image paths Claude writes in a reply (absolute, `~/`, relative, in backticks or markdown links), under that reply;
- images a tool returns (browser or MCP screenshots, Read of a PNG) and image paths in a tool's output, under the result.

Images are converted to PNG with macOS `sips` into `~/.cache/claude-inline-images` and drawn by the terminal from that file. Nothing leaves the machine.

Requires a terminal Claude Code draws images in: Ghostty (including cmux), or kitty 0.28+. Not inside tmux or screen.

Requires macOS (conversion uses the built-in `sips`) and a Claude Code build with mods (function-hooks plugins).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install inline-images --marketplace KDercksen/inline-images
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```sh
claude plugin install inline-images --marketplace KDercksen/inline-images
```

If your terminal draws kitty graphics but Claude Code does not detect it, start Claude Code with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`.

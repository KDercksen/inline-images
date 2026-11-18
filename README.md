# inline-images

A Claude Code mod that draws images inline in the terminal transcript, with no command to run:

- images pasted into a prompt, under that prompt's row;
- image paths Claude writes in a reply (absolute, `~/`, relative, in backticks or markdown links), under that reply;
- screenshots a browser or computer-use (MCP) tool returns as image data, under the result.

Tool output is never searched for image paths, so a search, listing or shell command stays text: an image shows when Claude names it in its reply. Several images draw as a grid of thumbnails (up to 12, then a "+N more" line); each has a link that opens the original file.

Images are converted to PNG with macOS `sips` into `~/.cache/claude-inline-images` and drawn by the terminal from that file. Nothing leaves the machine.

Animated GIFs play inline when `ffmpeg` is installed (`brew install ffmpeg`): their frames (up to 300, at most 800 px on a side) are extracted into the same cache and swapped in at the GIF's own frame delays. Up to 6 play at once; an animation stops when it scrolls out of view and resumes when drawn again. Without `ffmpeg` a GIF shows its first frame.

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

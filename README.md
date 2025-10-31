# TextForge Stylesheet (TFS)

VS Code extension for `.tfs` with:

- Syntax highlighting (directives, components, states, properties, values)
- Autocomplete for directives/properties/states/color tokens
- Live color rendering for color tokens and literals (#hex/rgba)
- Token name coloring (e.g., `error`, `primary`) across code — excluding comments/strings and property keys
- State blocks `[success]` `[hover]` are colored as a unit (brackets + names)

## Settings

- **tfs.enableColorHighlight** (default: `true`)  
  Color the token text itself; when `false`, only the square swatch is shown everywhere.

- **tfs.brightness.compensation**: `"auto" | "off"` (default: `auto`)  
  If `"auto"`, dark or low-alpha colors are brightened so text/swatches remain readable on dark backgrounds.

- **tfs.brightness.minLuminance** (default: `0.45`)  
  Target minimum relative luminance when compensation is enabled.

These features never recolor component definitions (e.g., `Text { ... }`); components show only the swatch.

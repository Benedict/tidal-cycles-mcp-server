# Contributing to TidalCycles MCP Server

First off, thank you for considering contributing to TidalCycles MCP Server! It's people like you that make the live coding community amazing.

## Code of Conduct

This project follows the spirit of the TOPLAP and algorave communities: be excellent to each other, celebrate experimentation, and keep it weird (in a good way).

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

**Bug Report Template:**

```markdown
**Describe the bug**
A clear description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Configure MCP server with '...'
2. Send pattern '...'
3. See error

**Expected behavior**
What you expected to happen.

**Environment:**
 - OS: [e.g. macOS 13.0]
 - Node.js version: [e.g. 18.16.0]
 - TidalCycles version: [e.g. 1.9.4]
 - SuperCollider version: [e.g. 3.13.0]
 - MCP Server version: [e.g. 1.0.0]

**Logs**
```
Paste relevant logs here
```

**Additional context**
Any other context about the problem.
```

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, include:

- **Clear title and description**
- **Use case**: Why would this be useful?
- **Possible implementation**: If you have ideas
- **Alternatives considered**: Other ways to achieve the goal

### Pull Requests

1. **Fork the repo** and create your branch from `main`
2. **Make your changes**
3. **Test your changes** thoroughly
4. **Update documentation** if needed
5. **Follow the code style** (see below)
6. **Write good commit messages** (see below)
7. **Submit a pull request**

## Development Setup

```bash
# Clone your fork
git clone https://github.com/your-username/tidal-mcp-server.git
cd tidal-mcp-server

# Install dependencies
npm install

# Start development mode (auto-rebuilds on changes)
npm run dev

# In another terminal, tail the logs
tail -f ~/.config/Claude/logs/mcp-server-tidal.log  # Linux
# or
tail -f ~/Library/Logs/Claude/mcp-server-tidal.log  # macOS
```

## Code Style

### TypeScript

- Use **TypeScript** for all new code
- Follow existing code style (2-space indentation)
- Use **meaningful variable names**
- Add **JSDoc comments** for public functions
- Use **async/await** over callbacks

**Example:**

```typescript
/**
 * Evaluates a TidalCycles pattern on a specific channel
 * @param channel - The channel to evaluate on (d1-d9)
 * @param pattern - The TidalCycles pattern code
 * @returns Promise resolving to the result
 */
private async evalPattern(channel: string, pattern: string): Promise<ToolResponse> {
  // Implementation
}
```

### Commit Messages

Follow conventional commits:

- `feat: add WebSocket support`
- `fix: resolve GHCi spawn error on Windows`
- `docs: update README with troubleshooting section`
- `refactor: simplify pattern evaluation logic`
- `test: add tests for hush command`
- `chore: update dependencies`

**Good commit message:**
```
feat: add pattern history with configurable limit

- Implements tidal_get_history tool
- Stores last N patterns with timestamps
- Allows configurable history limit via parameter
- Updates README with usage examples

Closes #42
```

**Bad commit message:**
```
fixed stuff
```

## Testing

### Manual Testing Checklist

Before submitting a PR, test:

- [ ] File-based mode works
- [ ] Direct GHCi mode works (if applicable)
- [ ] All tools function correctly (eval, hush, silence, solo, etc.)
- [ ] Error handling works (invalid patterns, missing samples, etc.)
- [ ] Works on your OS (specify which)
- [ ] Documentation is updated

### Automated Tests

We're working on automated tests. For now:

```bash
npm test
```

## Project Structure

```
src/
├── index.ts              # Main MCP server
│   ├── TidalMCPServer   # Main class
│   ├── setupToolHandlers # Tool definitions
│   ├── evalPattern       # Pattern evaluation
│   ├── startGhci         # GHCi process management
│   └── sendToGhci        # Direct communication
```

### Adding a New Tool

1. **Define the tool** in `setupToolHandlers()`:

```typescript
{
  name: "tidal_my_tool",
  description: "Does something awesome",
  inputSchema: {
    type: "object",
    properties: {
      param: {
        type: "string",
        description: "A parameter"
      }
    },
    required: ["param"]
  }
}
```

2. **Implement the handler** in the switch statement:

```typescript
case "tidal_my_tool":
  return await this.myTool(args.param as string);
```

3. **Add the method**:

```typescript
private async myTool(param: string) {
  // Implementation
  return {
    content: [
      {
        type: "text",
        text: "Result of my tool"
      }
    ]
  };
}
```

4. **Update README** with tool documentation
5. **Test thoroughly**

## Architecture Decisions

### Why Two Modes?

- **File mode**: More stable, works with existing editors, easier to debug
- **Direct GHCi mode**: No audio dropouts, better for live performance, experimental

### Why Node.js?

- MCP SDK is JavaScript/TypeScript
- Easy cross-platform process spawning
- Large ecosystem for potential future features

### Why Not Use Tidal's Built-in OSC?

- MCP requires structured tool calls
- Need state management (what's playing)
- Want conversation history
- Pattern generation benefits from LLM capabilities

## Common Development Tasks

### Adding Support for a New TidalCycles Feature

1. Test the feature manually in TidalCycles
2. Determine if it needs a new tool or can use existing `tidal_eval`
3. Update tool schemas if needed
4. Add examples to README
5. Test with Claude

### Improving Error Messages

Good error messages are crucial for UX:

```typescript
// ❌ Bad
throw new Error("Error");

// ✅ Good
throw new Error(
  `Failed to start GHCi: ${err.message}\n` +
  `Make sure ghci is installed and in PATH.\n` +
  `Try: which ghci`
);
```

### Debugging

**Enable verbose logging:**

```typescript
// In src/index.ts
console.error("Debug info:", someVariable);
```

**Check MCP logs:**

```bash
# macOS
tail -f ~/Library/Logs/Claude/mcp-server-tidal.log

# Linux
tail -f ~/.config/Claude/logs/mcp-server-tidal.log
```

**Test tool calls directly:**

```bash
# Start server in dev mode
npm run dev

# In another terminal, send test JSON to stdin
echo '{"method":"tools/call","params":{"name":"tidal_eval","arguments":{"channel":"d1","pattern":"sound \"bd\""}},"jsonrpc":"2.0","id":1}' | npm run dev
```

## Documentation

### README Updates

- Keep examples up-to-date
- Add troubleshooting for common issues
- Update architecture diagrams if structure changes
- Include version numbers for dependencies

### Code Comments

- Comment **why**, not **what**
- Explain non-obvious decisions
- Link to relevant TidalCycles docs
- Note any workarounds or hacks

## Release Process

1. Update version in `package.json`
2. Update CHANGELOG.md
3. Test on multiple OSes if possible
4. Create GitHub release with notes
5. Consider publishing to npm (TBD)

## Questions?

- Open a GitHub Discussion
- Ask in TidalCycles Discord
- Email the maintainers

## Recognition

Contributors will be recognized in:
- README.md acknowledgments section
- GitHub contributors page
- Release notes

Thank you for contributing to the weird and wonderful world of AI-assisted live coding! 🌀🎵

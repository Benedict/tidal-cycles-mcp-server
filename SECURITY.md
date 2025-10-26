# Security Policy

## Supported Versions

Currently supported versions with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please follow these steps:

### 1. Do Not Open a Public Issue

Please **do not** open a public GitHub issue if the bug is a security vulnerability.

### 2. Report Privately

Email security reports to: [your-email@example.com]

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### 3. Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Fix Timeline**: Depends on severity (typically 30-90 days)

### 4. Disclosure Policy

- We will work with you to understand and address the issue
- We will credit you in the security advisory (unless you prefer anonymity)
- We follow coordinated disclosure practices
- Security advisories will be published after fixes are released

## Security Considerations

### Running Untrusted Code

**⚠️ Warning**: This MCP server executes TidalCycles code that Claude generates. While Claude is designed to be helpful and harmless, always review patterns before execution in production environments.

### File System Access

The server:
- Only writes to the configured `TIDAL_FILE` location
- Only reads BootTidal.hs from configured location
- Does not traverse directories outside configured paths

### Process Spawning

In Direct GHCi mode:
- Spawns a single GHCi process
- Uses configured `GHCI_PATH` or system PATH
- Process is cleaned up on server shutdown

### Network Access

- No network access required (local only)
- Communicates via stdio with Claude Desktop
- TidalCycles communicates with SuperCollider via local OSC (port 57120)

## Best Practices

1. **Review Generated Code**: Check patterns before evaluation
2. **Use File Mode for Production**: More predictable than direct mode
3. **Limit File System Permissions**: Use principle of least privilege
4. **Keep Dependencies Updated**: Run `npm audit` regularly
5. **Use Specific Paths**: Use absolute paths in configuration

## Known Security Limitations

- No sandboxing of TidalCycles code execution
- No rate limiting on pattern evaluation
- No input validation on pattern complexity
- Relies on SuperCollider/SuperDirt security model

## Security Updates

Security updates will be released as:
- Patch versions for minor issues (1.0.x)
- Minor versions for moderate issues (1.x.0)
- Major versions for critical issues (x.0.0)

Subscribe to releases to stay informed: [GitHub Releases](https://github.com/yourusername/tidal-mcp-server/releases)

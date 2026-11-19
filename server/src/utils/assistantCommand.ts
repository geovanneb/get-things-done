/** A pasteable assistant command. Windows keeps the path out of the calling shell entirely. */
export function assistantCommand(
  workspace: string,
  program: 'claude' | 'codex' | 'copilot' | 'code',
  windows = false,
): string {
  if (windows) {
    // The launcher opens cmd, but users may paste into PowerShell instead. An ASCII-only invocation is safe in both;
    // PowerShell decodes UTF-16LE and receives the workspace as a literal path, including non-Latin characters.
    const script = `Set-Location -LiteralPath '${workspace.replace(/'/g, "''")}' -ErrorAction Stop; ${program === 'code' ? 'code .' : program}`;
    let binary = '';
    for (let i = 0; i < script.length; i++) {
      const unit = script.charCodeAt(i);
      binary += String.fromCharCode(unit & 0xff, unit >>> 8);
    }
    return `powershell -NoProfile -EncodedCommand ${btoa(binary)}`;
  }
  const quoted = "'" + workspace.replace(/'/g, "'\\''") + "'";
  return program === 'code' ? `code ${quoted}` : `cd ${quoted} && ${program}`;
}

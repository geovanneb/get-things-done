type Program = 'claude' | 'codex' | 'copilot' | 'code';

/**
 * Every character PowerShell reads as a single quote: ASCII `'` and the typographic U+2018, U+2019, U+201A and U+201B
 * (`CharExtensions.IsSingleQuote`). Inside a single-quoted string any of them ends the string unless it is doubled,
 * and nothing else is special there.
 */
const SINGLE_QUOTES = /['‘’‚‛]/g;

/**
 * Text for inside a single-quoted PowerShell string: each single quote of any kind doubled with itself, as
 * PowerShell's own `CodeGeneration.EscapeSingleQuotedStringContent` does. The tokenizer reads such a pair as one
 * literal character (the second of the pair), so the string holds the path exactly.
 */
export function escapeSingleQuoted(text: string): string {
  return text.replace(SINGLE_QUOTES, '$&$&');
}

/** The PowerShell script behind the Windows command: the path as one literal, single-quoted string. */
export function windowsAssistantScript(workspace: string, program: Program): string {
  return `Set-Location -LiteralPath '${escapeSingleQuoted(workspace)}' -ErrorAction Stop; ${program === 'code' ? 'code .' : program}`;
}

/** A pasteable assistant command. Windows keeps the path out of the calling shell entirely. */
export function assistantCommand(workspace: string, program: Program, windows = false): string {
  if (windows) {
    // The launcher opens cmd, but users may paste into PowerShell instead. An ASCII-only invocation is safe in both;
    // PowerShell decodes the UTF-16LE script (code units as they are) and receives the workspace as a literal path.
    const script = windowsAssistantScript(workspace, program);
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

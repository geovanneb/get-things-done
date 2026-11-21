type Program = 'claude' | 'codex' | 'copilot' | 'code';

/**
 * The arguments that start an assistant's interactive session with `prompt` already sent, as if the user typed it:
 * Claude Code and Codex take it as their first argument, the Copilot CLI after `-i`. The session stays the user's own,
 * in a window they see, so the tool asks for every permission as usual. VS Code takes none.
 */
export function promptArgs(program: Program, prompt: string | undefined): string[] {
  if (!prompt || program === 'code') return [];
  return program === 'copilot' ? ['-i', prompt] : [prompt];
}

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
export function windowsAssistantScript(workspace: string, program: Program, prompt?: string): string {
  const args = promptArgs(program, prompt).map((arg) => ` '${escapeSingleQuoted(arg)}'`).join('');
  return `Set-Location -LiteralPath '${escapeSingleQuoted(workspace)}' -ErrorAction Stop; ${program === 'code' ? 'code .' : program}${args}`;
}

/**
 * A pasteable assistant command, with `prompt` sent when it starts. Windows keeps the path and the prompt out of the
 * calling shell entirely.
 */
export function assistantCommand(workspace: string, program: Program, windows = false, prompt?: string): string {
  if (windows) {
    // The launcher opens cmd, but users may paste into PowerShell instead. An ASCII-only invocation is safe in both;
    // PowerShell decodes the UTF-16LE script (code units as they are) and receives the workspace as a literal path.
    const script = windowsAssistantScript(workspace, program, prompt);
    let binary = '';
    for (let i = 0; i < script.length; i++) {
      const unit = script.charCodeAt(i);
      binary += String.fromCharCode(unit & 0xff, unit >>> 8);
    }
    return `powershell -NoProfile -EncodedCommand ${btoa(binary)}`;
  }
  const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
  const args = promptArgs(program, prompt).map((arg) => ` ${quote(arg)}`).join('');
  return program === 'code' ? `code ${quote(workspace)}` : `cd ${quote(workspace)} && ${program}${args}`;
}

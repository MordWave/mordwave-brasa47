import { StringDecoder } from 'node:string_decoder';

// Interactive input that never echoes secrets. It needs a REAL terminal on both ends (stdin is read in raw mode, so no
// character is ever shown or buffered by the terminal); without one `isInteractive()` is false and the bootstrap refuses to
// run — there is deliberately no fallback that reads the password from a pipe, a file, an argument or the environment.
export interface Prompter {
  isInteractive(): boolean;
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
}

export class PromptAborted extends Error {
  constructor() {
    super('Entrada cancelada por el operador.');
  }
}

export interface TtyInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data' | 'end' | 'close', listener: (chunk?: Buffer | string) => void): unknown;
  off(event: 'data' | 'end' | 'close', listener: (chunk?: Buffer | string) => void): unknown;
}

export interface TtyOutput {
  isTTY?: boolean;
  write(text: string): unknown;
}

export function createTtyPrompter(input: TtyInput, output: TtyOutput): Prompter {
  const isInteractive = () => input.isTTY === true && output.isTTY === true && typeof input.setRawMode === 'function';

  function read(question: string, hidden: boolean): Promise<string> {
    if (!isInteractive()) return Promise.reject(new PromptAborted());
    output.write(question);
    input.setRawMode!(true);
    input.resume();
    const decoder = new StringDecoder('utf8');
    const chars: string[] = [];
    let escape: 0 | 1 | 2 = 0; // 1 = after ESC, 2 = inside a CSI sequence (arrow keys etc. are ignored)

    return new Promise<string>((resolve, reject) => {
      const done = (settle: () => void) => {
        input.off('data', onData);
        input.off('end', onEnd);
        input.off('close', onEnd);
        input.setRawMode!(false);
        input.pause();
        output.write('\n');
        settle();
      };
      const onEnd = () => done(() => reject(new PromptAborted()));
      const onData = (chunk?: Buffer | string) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk ?? Buffer.alloc(0));
        for (const byte of bytes) {
          if (escape === 1) {
            escape = byte === 0x5b ? 2 : 0;
            continue;
          }
          if (escape === 2) {
            if (byte >= 0x40 && byte <= 0x7e) escape = 0;
            continue;
          }
          if (byte === 0x0d || byte === 0x0a) return done(() => resolve(chars.join('')));
          if (byte === 0x03) return done(() => reject(new PromptAborted())); // Ctrl-C
          if (byte === 0x04) {
            if (chars.length === 0) return done(() => reject(new PromptAborted())); // Ctrl-D on an empty line
            continue;
          }
          if (byte === 0x1b) {
            escape = 1;
            continue;
          }
          if (byte === 0x7f || byte === 0x08) {
            if (chars.pop() !== undefined && !hidden) output.write('\b \b');
            continue;
          }
          if (byte < 0x20) continue;
          const text = decoder.write(Buffer.from([byte]));
          if (text === '') continue; // part of a multi-byte character
          for (const character of text) chars.push(character);
          if (!hidden) output.write(text);
        }
      };
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('close', onEnd);
    });
  }

  return {
    isInteractive,
    ask: (question) => read(question, false),
    askHidden: (question) => read(question, true),
  };
}

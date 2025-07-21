export interface EventSourceMessage {
  id: string;
  event: string;
  data: string;
  retry?: number;
}

/** 将请求体的 buffer 按行拆分，再逐行解析。 */
export class SSEParser {
  private decoder = new TextDecoder("utf-8");
  private buffer?: Uint8Array;
  private position = 0;
  private fieldLength = -1;
  private discardTrailingNewline = false;

  /**
   * 当前累积的事件对象
   */
  private currentMessage: EventSourceMessage = {
    id: "",
    event: "",
    data: "",
    retry: undefined,
  };

  constructor(
    private onMessage: (msg: EventSourceMessage) => void,
    private onId?: (id: string) => void,
    private onRetry?: (retry: number) => void
  ) {}

  /**
   * 解析到一行后，分发对应的字段
   */
  private parseLine(line: Uint8Array, fieldLength: number) {
    // 空行，说明一个事件结束
    if (line.length === 0) {
      this.onMessage(this.currentMessage);
      this.currentMessage = { id: "", event: "", data: "" };
      return;
    }

    // 根据 SSE 格式：形如 "field: value" 或 "field:  value"
    if (fieldLength > 0) {
      const field = this.decoder.decode(line.subarray(0, fieldLength));
      // 看看 field 后面是不是空格，如果是，则值要往后偏移 2，否则偏移 1
      const valueOffset =
        fieldLength + (line[fieldLength + 1] === 0x20 /* 空格 */ ? 2 : 1);
      const rawValue = line.subarray(valueOffset);
      const value = this.decoder.decode(rawValue);

      switch (field) {
        case "data":
          if (this.currentMessage.data) {
            this.currentMessage.data += "\n" + value;
          } else {
            this.currentMessage.data = value;
          }
          break;
        case "event":
          this.currentMessage.event = value;
          break;
        case "id":
          this.currentMessage.id = value;
          this.onId?.(value);
          break;
        case "retry":
          {
            const retry = parseInt(value, 10);
            if (!Number.isNaN(retry)) {
              this.currentMessage.retry = retry;
              this.onRetry?.(retry);
            }
          }
          break;
      }
    }
  }

  /**
   * 将新的流数据 chunk 喂给 SSEParser 进行拆解
   */
  public pushChunk(arr: Uint8Array) {
    if (!this.buffer) {
      this.buffer = arr;
      this.position = 0;
      this.fieldLength = -1;
    } else {
      // 追加到已有的 buffer 之后
      this.buffer = this.concat(this.buffer, arr);
    }

    const bufLength = this.buffer.length;
    let lineStart = 0;

    while (this.position < bufLength) {
      if (this.discardTrailingNewline) {
        if (this.buffer[this.position] === 0x0a /* LF */) {
          this.position++;
        }
        this.discardTrailingNewline = false;
      }

      let lineEnd = -1;
      for (; this.position < bufLength && lineEnd === -1; this.position++) {
        switch (this.buffer[this.position]) {
          case 0x3a /* : */:
            if (this.fieldLength === -1) {
              this.fieldLength = this.position - lineStart;
            }
            break;
          case 0x0d /* CR */:
            this.discardTrailingNewline = true;
          // eslint-disable-next-line no-fallthrough
          case 0x0a /* LF */:
            lineEnd = this.position;
            break;
        }
      }

      if (lineEnd === -1) {
        // 没有解析到完整行
        break;
      }

      // 拿到一行数据
      const line = this.buffer.subarray(lineStart, lineEnd);
      this.parseLine(line, this.fieldLength);

      // 初始化下一行
      lineStart = this.position;
      this.fieldLength = -1;
    }

    // 如果已经处理完 buffer 所有字节
    if (lineStart === bufLength) {
      this.buffer = undefined;
    } else if (lineStart !== 0) {
      // 将剩余还没处理完的部分截取出来
      this.buffer = this.buffer.subarray(lineStart);
      this.position -= lineStart;
    }
  }

  /**
   * SSE 结束后，如果还有未处理的行，通常这里可以做一些收尾处理。
   */
  public finish() {
    // 如果最后没有遇到空行，可能有一个尚未触发的事件
    // 通常 SSE 协议里事件都会以空行结尾
    // 不过可以根据需要，在这里再判断是否要派发事件
  }

  private concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const res = new Uint8Array(a.length + b.length);
    res.set(a);
    res.set(b, a.length);
    return res;
  }
}

class VoiceRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
    this.active = true;
    this.port.onmessage = () => {
      if (this.offset) this.port.postMessage(this.buffer.slice(0, this.offset));
      this.active = false;
      this.port.postMessage('stopped');
    };
  }
  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample=channels[0][i];
      for(let channel=1;channel<channels.length;channel++)sample+=channels[channel][i];
      this.buffer[this.offset++] = sample/channels.length;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-recorder', VoiceRecorder);

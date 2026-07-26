class PocketPcmStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.position = 0;
    this.sourceSampleRate = 24000;
    this.playbackRate = 1;
    this.ended = false;
    this.drained = false;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'configure') {
        this.sourceSampleRate = Math.max(8000, Number(data.sampleRate) || 24000);
        this.playbackRate = Math.max(0.5, Math.min(2, Number(data.playbackRate) || 1));
      } else if (data.type === 'segment' && data.audio) {
        const segment = data.audio instanceof Float32Array ? data.audio : new Float32Array(data.audio);
        if (segment.length) this.queue.push(segment);
      } else if (data.type === 'end') {
        this.ended = true;
      } else if (data.type === 'stop') {
        this.queue.length = 0;
        this.current = null;
        this.ended = true;
      }
    };
  }

  _nextSample() {
    while (!this.current || this.position >= this.current.length) {
      if (this.current) this.position -= this.current.length;
      this.current = this.queue.shift() || null;
      if (!this.current) return 0;
    }
    const left = Math.floor(this.position);
    const right = Math.min(this.current.length - 1, left + 1);
    const fraction = this.position - left;
    const value = this.current[left] + (this.current[right] - this.current[left]) * fraction;
    this.position += (this.sourceSampleRate / sampleRate) * this.playbackRate;
    return Number.isFinite(value) ? value : 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || left;
    for (let index = 0; index < left.length; index += 1) {
      const value = this._nextSample();
      left[index] = value;
      right[index] = value;
    }
    if (this.ended && !this.current && this.queue.length === 0 && !this.drained) {
      this.drained = true;
      this.port.postMessage({ type: 'drained' });
    }
    return true;
  }
}

registerProcessor('pocket-pcm-stream', PocketPcmStreamProcessor);

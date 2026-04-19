export class PCMRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  public onData: (base64Url: string) => void = () => {};

  async start(volume: number = 1.0) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
    this.context = new window.AudioContext({ sampleRate: 16000 });
    this.source = this.context.createMediaStreamSource(this.stream);
    
    this.gainNode = this.context.createGain();
    this.gainNode.gain.value = volume;

    this.processor = this.context.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      
      let binary = '';
      const bytes = new Uint8Array(pcm16.buffer);
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      this.onData(btoa(binary));
    };

    this.source.connect(this.gainNode);
    this.gainNode.connect(this.processor);
    this.processor.connect(this.context.destination);
  }

  setVolume(v: number) {
    if (this.gainNode) {
      this.gainNode.gain.value = v;
    }
  }

  stop() {
    if (this.processor && this.source && this.gainNode) {
      this.source.disconnect();
      this.gainNode.disconnect();
      this.processor.disconnect();
    }
    if (this.context) {
      this.context.close();
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
  }
}

export class PCMPlayer {
  private context: AudioContext | null = null;
  private nextTime: number = 0;
  private gainNode: GainNode | null = null;

  constructor(volume: number = 1.0) {
    if (typeof window !== "undefined") {
        this.context = new window.AudioContext({ sampleRate: 24000 });
        this.gainNode = this.context.createGain();
        this.gainNode.gain.value = volume;
        this.gainNode.connect(this.context.destination);
    }
  }
  
  setVolume(v: number) {
    if (this.gainNode) {
      this.gainNode.gain.value = v;
    }
  }

  playBase64PCM(base64: string) {
    if (!this.context || !this.gainNode) return;
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
      view[i] = binary.charCodeAt(i);
    }
    
    const int16View = new Int16Array(buffer);
    const float32Data = new Float32Array(int16View.length);
    for (let i = 0; i < int16View.length; i++) {
      float32Data[i] = int16View[i] / 0x8000;
    }

    const audioBuffer = this.context.createBuffer(1, float32Data.length, 24000);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);
    
    if (this.nextTime < this.context.currentTime) {
      this.nextTime = this.context.currentTime;
    }
    source.start(this.nextTime);
    this.nextTime += audioBuffer.duration;
  }
  
  stop() {
     if (this.context) {
       this.context.close();
       this.context = null;
     }
  }
}

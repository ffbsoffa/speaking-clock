// Cross-browser AudioManager without Howler.js dependency
class AudioManager {
    constructor() {
        this.globalVolume = 1.0;
        this.isMuted = false;
        this.audioCache = new Map();
        this.loadingPromises = new Map();
        
        // Web Audio API support for all browsers
        this.AudioContext = window.AudioContext || window.webkitAudioContext;
        this.context = null;
        this.gainNode = null;
        
        // Initialize audio context on first user interaction
        this.initPromise = null;
        
        // Preload queue for critical sounds
        this.preloadQueue = [];
        this.isPreloading = false;
        
        // Pool of HTML5 Audio elements for better performance
        this.audioPool = new Map();
        this.poolSize = 3;
    }
    
    async init() {
        if (this.context) return;
        
        try {
            this.context = new this.AudioContext();
            this.gainNode = this.context.createGain();
            this.gainNode.connect(this.context.destination);
            this.updateVolume();
            
            // Resume context if suspended (for Safari/Chrome)
            if (this.context.state === 'suspended') {
                await this.context.resume();
            }
        } catch (e) {
            console.error('Failed to initialize AudioContext:', e);
            // Fallback to HTML5 Audio
            this.context = null;
        }
    }
    
    async loadAudio(url) {
        // Check cache
        if (this.audioCache.has(url)) {
            return this.audioCache.get(url);
        }
        
        // Check if already loading
        if (this.loadingPromises.has(url)) {
            return this.loadingPromises.get(url);
        }
        
        // Create loading promise
        const loadPromise = this._loadAudioInternal(url);
        this.loadingPromises.set(url, loadPromise);
        
        try {
            const audioData = await loadPromise;
            this.audioCache.set(url, audioData);
            this.loadingPromises.delete(url);
            return audioData;
        } catch (error) {
            this.loadingPromises.delete(url);
            throw error;
        }
    }
    
    async _loadAudioInternal(url) {
        // If Web Audio API is available
        if (this.context) {
            try {
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await this.context.decodeAudioData(arrayBuffer);
                return { type: 'webaudio', buffer: audioBuffer };
            } catch (e) {
                console.warn('Failed to load via Web Audio API, falling back to HTML5 Audio:', e);
            }
        }
        
        // Fallback to HTML5 Audio with pooling
        return new Promise((resolve, reject) => {
            const audio = new Audio();
            audio.preload = 'auto';
            
            audio.addEventListener('canplaythrough', () => {
                // Create pool of audio elements for this URL
                this._createAudioPool(url, audio);
                resolve({ type: 'html5', audio: audio });
            }, { once: true });
            
            audio.addEventListener('error', (e) => {
                reject(new Error(`Failed to load audio: ${url}`));
            }, { once: true });
            
            audio.src = url;
            audio.load();
        });
    }
    
    _createAudioPool(url, originalAudio) {
        if (!this.audioPool.has(url)) {
            const pool = [];
            for (let i = 0; i < this.poolSize; i++) {
                const audioClone = originalAudio.cloneNode();
                audioClone.preload = 'auto';
                pool.push(audioClone);
            }
            this.audioPool.set(url, pool);
        }
    }
    
    _getPooledAudio(url) {
        const pool = this.audioPool.get(url);
        if (!pool || pool.length === 0) return null;
        
        // Find an available audio element
        for (let i = 0; i < pool.length; i++) {
            const audio = pool[i];
            if (audio.paused || audio.ended) {
                audio.currentTime = 0;
                return audio;
            }
        }
        
        // If no available element, return the first one
        return pool[0].cloneNode();
    }
    
    async play(url, options = {}) {
        await this.init();
        
        try {
            const audioData = await this.loadAudio(url);
            
            if (audioData.type === 'webaudio' && this.context) {
                return this._playWebAudio(audioData.buffer, options);
            } else {
                return this._playHTML5Audio(audioData.audio, options);
            }
        } catch (error) {
            console.error('Failed to play audio:', error);
            throw error;
        }
    }
    
    _playWebAudio(buffer, options) {
        return new Promise((resolve) => {
            const source = this.context.createBufferSource();
            source.buffer = buffer;
            
            // Create gain node for individual volume
            const gainNode = this.context.createGain();
            gainNode.gain.value = options.volume || 1.0;
            
            source.connect(gainNode);
            gainNode.connect(this.gainNode);
            
            source.onended = () => {
                resolve();
                if (options.onEnd) options.onEnd();
            };
            
            source.start(0);
        });
    }
    
    _playHTML5Audio(audio, options) {
        return new Promise((resolve) => {
            // Try to get a pooled audio element first
            const pooledAudio = this._getPooledAudio(audio.src);
            const audioToPlay = pooledAudio || audio.cloneNode();
            
            audioToPlay.volume = this.isMuted ? 0 : (this.globalVolume * (options.volume || 1.0));
            
            // Preload the audio to ensure it's ready
            audioToPlay.preload = 'auto';
            
            const cleanup = () => {
                audioToPlay.removeEventListener('ended', onEnded);
                audioToPlay.removeEventListener('error', onError);
            };
            
            const onEnded = () => {
                cleanup();
                resolve();
                if (options.onEnd) options.onEnd();
            };
            
            const onError = (e) => {
                cleanup();
                console.error('Failed to play HTML5 audio:', e);
                resolve();
            };
            
            audioToPlay.addEventListener('ended', onEnded, { once: true });
            audioToPlay.addEventListener('error', onError, { once: true });
            
            // Reset position for better timing accuracy
            try {
                audioToPlay.currentTime = 0;
            } catch (e) {
                // Some browsers don't allow setting currentTime
            }
            
            audioToPlay.play().catch(e => {
                cleanup();
                console.error('Failed to play HTML5 audio:', e);
                resolve();
            });
        });
    }
    
    setVolume(volume) {
        this.globalVolume = Math.max(0, Math.min(1, volume));
        this.updateVolume();
    }
    
    setMute(muted) {
        this.isMuted = muted;
        this.updateVolume();
    }
    
    updateVolume() {
        if (this.gainNode) {
            this.gainNode.gain.value = this.isMuted ? 0 : this.globalVolume;
        }
    }
    
    async playSequence(sounds) {
        for (const sound of sounds) {
            await this.play(sound.url, sound.options);
        }
    }
    
    // Preload critical sounds to avoid timing issues
    async preloadSounds(urls) {
        const promises = urls.map(url => this.loadAudio(url).catch(e => {
            console.warn(`Failed to preload ${url}:`, e);
        }));
        await Promise.all(promises);
    }
    
    // Schedule precise playback using Web Audio API timing
    async schedulePlay(url, delayMs, options = {}) {
        await this.init();
        
        try {
            const audioData = await this.loadAudio(url);
            
            if (audioData.type === 'webaudio' && this.context) {
                // Use Web Audio API's precise scheduling
                const startTime = this.context.currentTime + (delayMs / 1000);
                return this._scheduleWebAudio(audioData.buffer, startTime, options);
            } else {
                // Enhanced fallback for HTML5 Audio
                const targetTime = Date.now() + delayMs;
                
                // For better accuracy, use multiple smaller timeouts
                return new Promise(resolve => {
                    const checkAndPlay = () => {
                        const now = Date.now();
                        const remaining = targetTime - now;
                        
                        if (remaining <= 0) {
                            // Time to play
                            this._playHTML5Audio(audioData.audio, options).then(resolve);
                        } else if (remaining < 50) {
                            // Less than 50ms - use tight loop
                            setTimeout(checkAndPlay, Math.min(10, remaining));
                        } else {
                            // More time remaining - check again later
                            setTimeout(checkAndPlay, Math.min(50, remaining - 40));
                        }
                    };
                    
                    checkAndPlay();
                });
            }
        } catch (error) {
            console.error('Failed to schedule audio:', error);
            throw error;
        }
    }
    
    _scheduleWebAudio(buffer, startTime, options) {
        return new Promise((resolve) => {
            const source = this.context.createBufferSource();
            source.buffer = buffer;
            
            const gainNode = this.context.createGain();
            gainNode.gain.value = options.volume || 1.0;
            
            source.connect(gainNode);
            gainNode.connect(this.gainNode);
            
            source.onended = () => {
                resolve();
                if (options.onEnd) options.onEnd();
            };
            
            // Schedule precise playback
            source.start(startTime);
        });
    }
}

// Create global instance
const audioManager = new AudioManager();
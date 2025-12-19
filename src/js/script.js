// --- Service Worker Cleanup (Remove Offline Capability) ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (registrations) {
        for (let registration of registrations) {
            registration.unregister().then(function (boolean) {
                console.log('Service Worker unregistered: ', boolean);
            });
        }
    });
}

// --- Debug Logging ---
function logAudioDebug(msg, isError = false) {
    const ui = document.getElementById('debug-ui');
    const log = document.getElementById('debug-log');
    if (ui && log) {
        ui.classList.remove('hidden');
        const entry = document.createElement('div');
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        if (isError) entry.classList.add('text-red-500', 'font-bold');
        else entry.classList.add('text-green-500');
        log.appendChild(entry);
    }
    console.log(`[AudioDebug] ${msg}`);
}

// --- Audio Engine (Web Audio API) ---
class AudioEngine {
    constructor() {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContext();

        // Master Chain: MasterGain -> Analyser -> Destination
        this.masterGain = this.ctx.createGain();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 256; // For visualizer sensitivity

        this.masterGain.connect(this.analyser);
        this.analyser.connect(this.ctx.destination);

        this.tracks = {};
        this.generators = {};

        this.spatialEnabled = false;
        this.spatialTime = 0;

        this.isMuted = true; // Start muted to match UI 'Play' state
        this.masterVolume = 1.0;

        // Resume context
        ['click', 'touchstart', 'keydown'].forEach(evt =>
            document.addEventListener(evt, () => {
                if (this.ctx.state === 'suspended') this.ctx.resume();
            }, { once: true })
        );

        this.startSpatialLoop();
        this.setupMediaSession();
    }

    async addTrack(id) {
        const element = document.getElementById(id);
        if (!element) return;

        const src = element.getAttribute('src');
        if (!src) {
            logAudioDebug(`No src attribute found for ${id}`, true);
            return;
        }

        try {
            // Fetch the audio file and decode it as an AudioBuffer
            // This bypasses CORS issues with MediaElementAudioSourceNode
            logAudioDebug(`Loading ${id} via fetch...`);
            const response = await fetch(src);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for ${src}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

            const gain = this.ctx.createGain();
            const panner = this.ctx.createStereoPanner();
            gain.connect(panner).connect(this.masterGain);
            gain.gain.value = 0;

            this.tracks[id] = {
                buffer: audioBuffer,
                gain,
                panner,
                source: null, // Will be created when playing
                isPlaying: false,
                type: 'buffer'
            };
            logAudioDebug(`${id} loaded successfully`);
        } catch (e) {
            console.warn(`Buffer loading failed for ${id}, falling back to HTML5 Audio.`, e);
            logAudioDebug(`Fallback to HTML5 for ${id}: ${e.message}`, true);
            element.volume = 0;
            element.muted = this.isMuted;
            this.tracks[id] = { element, type: 'html5' };
        }
    }

    setTrackVolume(id, vol) {
        if (this.tracks[id]) {
            const track = this.tracks[id];
            if (track.type === 'buffer') {
                track.gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.1);
                if (vol > 0 && !track.isPlaying) {
                    // Create a new buffer source and start it
                    const source = this.ctx.createBufferSource();
                    source.buffer = track.buffer;
                    source.loop = true;
                    source.connect(track.gain);
                    source.start(0);
                    track.source = source;
                    track.isPlaying = true;
                    logAudioDebug(`Started playing ${id}`);
                } else if (vol === 0 && track.isPlaying) {
                    // Stop the source after fade out
                    setTimeout(() => {
                        if (track.gain.gain.value < 0.01 && track.source) {
                            track.source.stop();
                            track.source.disconnect();
                            track.source = null;
                            track.isPlaying = false;
                            logAudioDebug(`Stopped ${id}`);
                        }
                    }, 200);
                }
            } else if (track.type === 'webaudio') {
                track.gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.1);
                if (vol > 0 && track.element.paused) {
                    track.element.play().catch(e => console.error(e));
                } else if (vol === 0) {
                    setTimeout(() => { if (track.gain.gain.value < 0.01) track.element.pause(); }, 200);
                }
            } else {
                // Fallback HTML5
                track.element.volume = vol;
                if (vol > 0 && track.element.paused) {
                    track.element.play().catch(e => console.error(e));
                } else if (vol === 0) {
                    track.element.pause();
                }
            }
        }
    }

    fadeMasterOut(duration = 10) {
        this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this.ctx.currentTime);
        this.masterGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + duration);
    }

    resetMasterVolume() {
        this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.masterGain.gain.setTargetAtTime(this.isMuted ? 0 : this.masterVolume, this.ctx.currentTime, 0.5);
    }

    playChime() {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, this.ctx.currentTime + 1.5);
        gain.gain.setValueAtTime(0.5, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 1.5);
        osc.start();
        osc.stop(this.ctx.currentTime + 1.5);
    }

    toggleSpatial(enabled) {
        this.spatialEnabled = enabled;
        if (!enabled) {
            Object.values(this.tracks).forEach(t => {
                if (t.panner) t.panner.pan.setTargetAtTime(0, this.ctx.currentTime, 0.5);
            });
        }
    }

    startSpatialLoop() {
        const animate = () => {
            if (this.spatialEnabled) {
                this.spatialTime += 0.005;
                Object.values(this.tracks).forEach((track, index) => {
                    if (track.panner) {
                        const offset = index * (Math.PI / 2);
                        const pan = Math.sin(this.spatialTime + offset) * 0.7;
                        track.panner.pan.setValueAtTime(pan, this.ctx.currentTime);
                    }
                });
            }
            requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }

    // --- Noise Generators ---
    createNoiseBuffer(type) {
        const bufferSize = 2 * this.ctx.sampleRate;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);

        if (type === 'brown') {
            let lastOut = 0;
            for (let i = 0; i < bufferSize; i++) {
                const white = Math.random() * 2 - 1;
                data[i] = (lastOut + (0.02 * white)) / 1.02;
                lastOut = data[i];
                data[i] *= 3.5;
            }
        } else if (type === 'white') {
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
        } else if (type === 'pink') {
            let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
            for (let i = 0; i < bufferSize; i++) {
                const white = Math.random() * 2 - 1;
                b0 = 0.99886 * b0 + white * 0.0555179;
                b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.96900 * b2 + white * 0.1538520;
                b3 = 0.86650 * b3 + white * 0.3104856;
                b4 = 0.55000 * b4 + white * 0.5329522;
                b5 = -0.7616 * b5 - white * 0.0168980;
                data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
                data[i] *= 0.11;
                b6 = white * 0.115926;
            }
        }
        return buffer;
    }

    updateGenerator(id, vol, createFn) {
        if (!this.generators[id]) {
            this.generators[id] = { gain: this.ctx.createGain(), nodes: [], active: false };
            this.generators[id].gain.connect(this.masterGain);
        }
        const gen = this.generators[id];
        gen.gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.1);

        if (vol > 0 && !gen.active) {
            const result = createFn();
            let outputNode, startables;
            if (result.length === 1) { outputNode = result[0]; startables = [result[0]]; }
            else { outputNode = result[result.length - 1]; startables = result.slice(0, result.length - 1); }

            outputNode.connect(gen.gain);
            startables.forEach(s => s.start());
            gen.nodes = result;
            gen.active = true;
        } else if (vol === 0 && gen.active) {
            setTimeout(() => {
                if (gen.gain.gain.value < 0.01) {
                    gen.nodes.forEach(n => { if (n.stop) n.stop(); n.disconnect(); });
                    gen.nodes = [];
                    gen.active = false;
                }
            }, 200);
        }
    }

    enableBrownNoise(vol) {
        this.updateGenerator('brown', vol, () => {
            const src = this.ctx.createBufferSource();
            src.buffer = this.createNoiseBuffer('brown');
            src.loop = true;
            return [src];
        });
    }

    enablePinkNoise(vol) {
        this.updateGenerator('pink', vol, () => {
            const src = this.ctx.createBufferSource();
            src.buffer = this.createNoiseBuffer('pink');
            src.loop = true;
            return [src];
        });
    }

    enableGreenNoise(vol) {
        this.updateGenerator('green', vol, () => {
            const src = this.ctx.createBufferSource();
            src.buffer = this.createNoiseBuffer('white');
            src.loop = true;

            // Green noise is standard white noise filtered to simulate nature (mid-freq)
            // Center around 500Hz with a broad bandpass
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 500;
            filter.Q.value = 0.5;

            // Chain: Source -> Filter
            src.connect(filter);

            // Return [src, filter] so the last one connects to master
            return [src, filter];
        });
    }

    enableBinaural(type, vol) {
        const diff = type === 'focus' ? 40 : 4;
        this.updateGenerator(`binaural-${type}`, vol, () => {
            const oscL = this.ctx.createOscillator();
            const oscR = this.ctx.createOscillator();
            const merger = this.ctx.createChannelMerger(2);
            oscL.frequency.value = 200;
            oscR.frequency.value = 200 + diff;
            oscL.connect(merger, 0, 0);
            oscR.connect(merger, 0, 1);
            return [oscL, oscR, merger];
        });
    }

    toggleMasterMute() {
        this.isMuted = !this.isMuted;
        const target = this.isMuted ? 0 : this.masterVolume;
        this.masterGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.1);

        Object.values(this.tracks).forEach(t => {
            if (t.type === 'html5') t.element.muted = this.isMuted;
        });

        this.updateMediaSessionState();
        return !this.isMuted;
    }

    getAnalysis() {
        const data = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(data);
        // Average magnitude from frequency data
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        let freqIntensity = sum / data.length; // 0-255

        // Also check if any tracks are actively playing (fallback for quiet sounds)
        let hasActiveAudio = false;
        for (const id in this.tracks) {
            const track = this.tracks[id];
            // Check buffer-based tracks (isPlaying flag)
            if (track.isPlaying) {
                hasActiveAudio = true;
                break;
            }
            // Check HTML5 fallback tracks (element.paused property)
            if (track.element && !track.element.paused && track.element.volume > 0) {
                hasActiveAudio = true;
                break;
            }
        }
        // Check generators too
        if (!hasActiveAudio) {
            for (const id in this.generators) {
                const gen = this.generators[id];
                if (gen.active) {
                    hasActiveAudio = true;
                    break;
                }
            }
        }

        // If we have active audio but frequency data is low, return minimum threshold
        if (hasActiveAudio && freqIntensity < 15) {
            freqIntensity = 25; // Minimum to trigger eye open
        }

        return freqIntensity;
    }

    // --- Media Session API ---
    setupMediaSession() {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: "The Dragon's Keep",
                artist: "Ambient Atmosphere",
                album: "Relaxation",
                artwork: [
                    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
                ]
            });
            navigator.mediaSession.setActionHandler('play', () => {
                if (this.isMuted) this.toggleMasterMute();
                updateMasterBtnUI();
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                if (!this.isMuted) this.toggleMasterMute();
                updateMasterBtnUI();
            });
            navigator.mediaSession.setActionHandler('stop', () => {
                // Fade out?
                this.toggleMasterMute();
                updateMasterBtnUI();
            });
        }
    }
    updateMediaSessionState() {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = this.isMuted ? 'paused' : 'playing';
        }
    }
}

// --- App ---
const audio = new AudioEngine();
const state = {
    volumes: {},
    timer: 0,
};

document.addEventListener('DOMContentLoaded', async () => {
    const trackIds = ['valley-audio', 'sleeping-audio', 'rain-audio', 'fireplace-audio'];

    // Load tracks in background (fire and forget)
    trackIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.loop = true;
            audio.addTrack(id);
        }
    });

    setupControls();
    setupProductivity();
    initVisuals();
    initBackgrounds();
    setupKeyboard();

    // Minimalist Toggle
    document.getElementById('minimalist-btn').addEventListener('click', () => {
        document.body.classList.toggle('minimalist');
    });
});

function setupControls() {
    // Helper to update sound card UI (active state + volume indicator)
    function updateSoundCardUI(slider) {
        const card = slider.closest('.sound-card');
        if (card) {
            const val = parseFloat(slider.value);
            const max = parseFloat(slider.max);
            const normalized = val / max;

            // Update volume indicator bar
            const indicator = card.querySelector('.volume-indicator');
            if (indicator) {
                indicator.style.transform = `scaleX(${normalized})`;
            }

            // Toggle active state
            if (val > 0) {
                card.classList.add('active');
            } else {
                card.classList.remove('active');
            }
        }
    }

    const sliderMap = {
        'vol-valley': 'valley-audio', 'vol-sleeping': 'sleeping-audio',
        'vol-rain': 'rain-audio', 'vol-fireplace': 'fireplace-audio'
    };
    Object.keys(sliderMap).forEach(sliderId => {
        const slider = document.getElementById(sliderId);
        slider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            audio.setTrackVolume(sliderMap[sliderId], val);
            state.volumes[sliderId] = val;
            updateSoundCardUI(e.target);
        });
    });

    document.getElementById('vol-brown').addEventListener('input', e => {
        audio.enableBrownNoise(parseFloat(e.target.value));
        state.volumes['vol-brown'] = parseFloat(e.target.value);
        updateSoundCardUI(e.target);
    });
    document.getElementById('vol-pink').addEventListener('input', e => {
        audio.enablePinkNoise(parseFloat(e.target.value));
        state.volumes['vol-pink'] = parseFloat(e.target.value);
        updateSoundCardUI(e.target);
    });
    document.getElementById('vol-green').addEventListener('input', e => {
        audio.enableGreenNoise(parseFloat(e.target.value));
        state.volumes['vol-green'] = parseFloat(e.target.value);
        updateSoundCardUI(e.target);
    });
    document.getElementById('vol-binaural-40').addEventListener('input', e => {
        audio.enableBinaural('focus', parseFloat(e.target.value));
        state.volumes['vol-binaural-40'] = parseFloat(e.target.value);
        updateSoundCardUI(e.target);
    });
    document.getElementById('vol-binaural-4').addEventListener('input', e => {
        audio.enableBinaural('sleep', parseFloat(e.target.value));
        state.volumes['vol-binaural-4'] = parseFloat(e.target.value);
        updateSoundCardUI(e.target);
    });

    const btn = document.getElementById('master-btn');
    let hasInteractedWithAudio = false;

    btn.addEventListener('click', () => {
        // Auto-play random sound if first time and silence
        if (!hasInteractedWithAudio) {
            hasInteractedWithAudio = true;
            let currentTotalVol = 0;
            // Check ambient sliders
            Object.values(sliderMap).forEach(id => {
                // Find slider key for this id
                const key = Object.keys(sliderMap).find(k => sliderMap[k] === id);
                const el = document.getElementById(key);
                if (el) currentTotalVol += parseFloat(el.value);
            });
            // Also check generators? (Usually they are 0 at start)

            if (currentTotalVol === 0) {
                const keys = Object.keys(sliderMap);
                const randomKey = keys[Math.floor(Math.random() * keys.length)];
                const el = document.getElementById(randomKey);
                if (el) {
                    el.value = 0.3;
                    el.dispatchEvent(new Event('input'));
                    logAudioDebug(`Auto-selected ${randomKey} at 30%`);
                }
            }
        }

        audio.toggleMasterMute();
        updateMasterBtnUI();
    });

    document.getElementById('spatial-btn').addEventListener('click', function () {
        audio.spatialEnabled = !audio.spatialEnabled;
        audio.toggleSpatial(audio.spatialEnabled);
        this.innerText = `Spatial Audio: ${audio.spatialEnabled ? 'On' : 'Off'}`;
        this.classList.toggle('border-red-900', audio.spatialEnabled);
        this.classList.toggle('text-amber-100', audio.spatialEnabled);
        this.classList.toggle('spatial-active', audio.spatialEnabled);
    });
}

function updateMasterBtnUI() {
    const btn = document.getElementById('master-btn');
    const isPlaying = !audio.isMuted;
    btn.querySelector('#master-icon-play').classList.toggle('hidden', isPlaying);
    btn.querySelector('#master-icon-pause').classList.toggle('hidden', !isPlaying);
    btn.classList.toggle('bg-red-900/40', isPlaying);
    btn.classList.toggle('text-red-300', isPlaying);
    btn.classList.toggle('text-red-500', !isPlaying);
}

function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            audio.toggleMasterMute();
            updateMasterBtnUI();
        }
    });
}

function setupProductivity() {
    // --- Sleep Timer ---
    const display = document.getElementById('timer-display');
    const input = document.getElementById('timer-input');
    let timerInt;

    window.setCustomTimer = () => startTimer(parseInt(input.value) * 60);
    window.addTime = (m) => startTimer(m * 60);
    window.clearTime = () => {
        clearInterval(timerInt);
        display.innerText = "Off";
        audio.resetMasterVolume();
    };

    function startTimer(secs) {
        clearInterval(timerInt);
        let left = secs;
        audio.resetMasterVolume();
        const tick = () => {
            const h = Math.floor(left / 3600);
            const m = Math.floor((left % 3600) / 60);
            display.innerText = h > 0 ? `${h}h ${m}m` : `${m}m`;
            if (left === 60) audio.fadeMasterOut(60);
            if (left <= 0) {
                window.clearTime();
                document.querySelectorAll('input[type=range]').forEach(el => {
                    el.value = 0; el.dispatchEvent(new Event('input'));
                });
                audio.resetMasterVolume();
            }
            left--;
        };
        tick();
        timerInt = setInterval(tick, 1000);
    }

    // --- Pomodoro ---
    const pDisplay = document.getElementById('pomo-display');
    const pStatus = document.getElementById('pomo-status');
    const pStart = document.getElementById('pomo-start-btn');
    const pReset = document.getElementById('pomo-reset-btn');

    let pomoInt, pomoTime = 25 * 60, isBreak = false, isRunning = false;
    function updatePomoDisplay() {
        const m = Math.floor(pomoTime / 60).toString().padStart(2, '0');
        const s = (pomoTime % 60).toString().padStart(2, '0');
        pDisplay.innerText = `${m}:${s}`;
    }
    pStart.addEventListener('click', () => {
        if (isRunning) {
            clearInterval(pomoInt);
            isRunning = false;
            pStart.innerText = "Start";
        } else {
            isRunning = true;
            pStart.innerText = "Pause";
            pomoInt = setInterval(() => {
                pomoTime--;
                updatePomoDisplay();
                if (pomoTime <= 0) {
                    audio.playChime();
                    switchMode(!isBreak);
                }
            }, 1000);
        }
    });
    pReset.addEventListener('click', () => {
        clearInterval(pomoInt);
        isRunning = false;
        pStart.innerText = "Start";
        switchMode(false, true);
    });
    function switchMode(toBreak, reset = false) {
        isBreak = toBreak;
        pomoTime = (isBreak ? 5 : 25) * 60;
        updatePomoDisplay();
        document.getElementById('pomo-mode-focus').classList.toggle('text-red-700', !isBreak);
        document.getElementById('pomo-mode-break').classList.toggle('text-green-500', isBreak);
        pStatus.innerText = isBreak ? "Rest" : "Focus";
        if (!reset && !isRunning) { } // Pause on auto switch? Or auto? Manual is simpler.
    }

    // --- Presets ---
    const presetList = document.getElementById('preset-list');
    const presetName = document.getElementById('preset-name');
    const saveBtn = document.getElementById('save-preset-btn');

    function loadPresets() {
        const saved = JSON.parse(localStorage.getItem('dragon_presets') || '{}');
        presetList.innerHTML = '';
        if (Object.keys(saved).length === 0) {
            presetList.innerHTML = '<div class="text-stone-600 text-sm italic text-center py-2">No saved presets</div>';
            return;
        }
        Object.entries(saved).forEach(([name, vols]) => {
            const div = document.createElement('div');
            div.className = 'flex justify-between items-center bg-stone-950 p-2 rounded border border-stone-800 hover:border-amber-900 group';
            div.innerHTML = `
                <span class="text-stone-300 text-sm font-bold truncate cursor-pointer flex-1">${name}</span>
                <button class="delete-preset text-stone-600 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            `;
            div.querySelector('span').addEventListener('click', () => applyPreset(vols));
            div.querySelector('.delete-preset').addEventListener('click', () => {
                delete saved[name];
                localStorage.setItem('dragon_presets', JSON.stringify(saved));
                loadPresets();
            });
            presetList.appendChild(div);
        });
    }
    function applyPreset(vols) {
        Object.keys(vols).forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.value = vols[id]; el.dispatchEvent(new Event('input')); }
        });
    }
    saveBtn.addEventListener('click', () => {
        const name = presetName.value.trim();
        if (!name) return;
        const currentVols = {};
        document.querySelectorAll('input[type=range]').forEach(el => currentVols[el.id] = parseFloat(el.value));
        const saved = JSON.parse(localStorage.getItem('dragon_presets') || '{}');
        saved[name] = currentVols;
        localStorage.setItem('dragon_presets', JSON.stringify(saved));
        presetName.value = '';
        loadPresets();
    });
    loadPresets();
}

function initVisuals() {
    const canvas = document.getElementById('embers-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let embers = [];
    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    window.addEventListener('resize', resize);
    resize();
    class Ember {
        constructor() { this.reset(); this.y = Math.random() * canvas.height; }
        reset() {
            this.x = Math.random() * canvas.width;
            this.y = canvas.height + 50;
            this.size = Math.random() * 3 + 1;
            this.speed = Math.random() * 1 + 0.5;
            this.opacity = Math.random();
        }
        update(intensity) {
            // Reactive speed
            const speedMod = 1 + (intensity / 50); // 1.0 to 6.0 roughly
            this.y -= this.speed * speedMod;
            if (this.y < -10) this.reset();
        }
        draw(intensity) {
            // Reactive size/glow
            const sizeMod = 1 + (intensity / 200);
            ctx.shadowBlur = this.size * 5 * sizeMod;
            ctx.shadowColor = `rgba(255, ${100 + intensity}, 0, ${this.opacity})`;
            ctx.fillStyle = `rgba(255, ${100 + intensity / 2}, 0, ${this.opacity})`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size * sizeMod, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    for (let i = 0; i < 100; i++) embers.push(new Ember());

    // Track eye state for smooth lerping
    let eyeScale = 0.1;

    function animate() {
        if (document.hidden) { requestAnimationFrame(animate); return; }

        // Get audio data
        const intensity = audio.getAnalysis(); // 0-255

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        embers.forEach(e => { e.update(intensity); e.draw(intensity); });

        // Update eye glow and container scale
        const container = document.getElementById('visualizer-container');
        const glow = document.getElementById('visualizer-glow');
        const eyeGroup = document.getElementById('dragon-eye-group');

        if (intensity > 5) {
            const scale = 1 + (intensity / 1000); // 1.0 to 1.25
            container.style.transform = `scale(${scale})`;
            glow.style.opacity = intensity / 300; // 0 to 0.8
        } else {
            container.style.transform = 'scale(1)';
            glow.style.opacity = 0;
        }

        if (eyeGroup) {
            // Dynamic Eye Opening Logic
            // Map intensity (0-200) to scale (0.1 - 1.0)
            let targetScale = 0.1 + (intensity / 200) * 0.9;
            if (targetScale > 1.0) targetScale = 1.0;
            if (targetScale < 0.1) targetScale = 0.1;

            // Smoothly interpolate current scale to target (Lerp)
            eyeScale += (targetScale - eyeScale) * 0.1; // 0.1 easing factor

            eyeGroup.style.transform = `scaleY(${eyeScale})`;
            eyeGroup.style.opacity = 0.5 + (eyeScale * 0.5); // Dimmer when closed

            // Clear class-based animations if they conflict
            eyeGroup.classList.remove('eye-closed', 'eye-open');
        }

        requestAnimationFrame(animate);
    }
    animate();
}

function initBackgrounds() {
    const bgSettingsBtn = document.getElementById('bg-settings-btn');
    const bgModal = document.getElementById('bg-modal');
    if (!bgSettingsBtn || !bgModal) return;
    bgSettingsBtn.addEventListener('click', () => {
        bgModal.classList.remove('hidden');
        setTimeout(() => bgModal.classList.remove('opacity-0'), 10);
    });
    const close = () => {
        bgModal.classList.add('opacity-0');
        setTimeout(() => bgModal.classList.add('hidden'), 300);
    };
    document.getElementById('bg-modal-close').addEventListener('click', close);
    window.selectBackground = (type) => {
        const bgLayer = document.getElementById('bg-layer');
        const bgVideo = document.getElementById('bg-video');
        let bgUrl = '';
        let videoUrl = '';

        // Hide video by default, show if needed
        bgVideo.classList.add('hidden', 'opacity-0');
        bgLayer.classList.remove('opacity-0');

        switch (type) {
            case 'obsidian': bgUrl = `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%239C92AC' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`; break;
            case 'Crimson': bgUrl = `linear-gradient(to bottom right, #450a0a, #000000)`; break;
            case 'Misty': bgUrl = `linear-gradient(to top, #0f172a, #1e293b)`; break;
            case 'Golden': bgUrl = `radial-gradient(circle at center, #78350f, #2a1b0e)`; break;
            case 'Emerald': bgUrl = `linear-gradient(to top left, #064e3b, #022c22)`; break;
            case 'Amethyst': bgUrl = `linear-gradient(to bottom, #581c87, #000000)`; break;
        }

        bgLayer.style.backgroundImage = bgUrl;
        localStorage.setItem('dragon_keep_bg', type);
        close();
    };
    const saved = localStorage.getItem('dragon_keep_bg');
    if (saved) window.selectBackground(saved);
}

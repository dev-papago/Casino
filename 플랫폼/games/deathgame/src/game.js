// 데스 게임 (THE FINAL SEAT): five stages in a row; clearing all of them pays PLATFORM.deathGame.reward chips.
// Opened by the player app (?casino), the page asks the server for a run first, reports every stage it clears
// (the server refuses a stage out of order or faster than a person can play it) and then claims the reward. A
// failed run costs nothing: start again from the title. Without ?casino it is practice: the same game, no chips.
import './style.css';
import * as casino from '../../../sdk/casino.ts';
import { PLATFORM } from '../../../src/shared/config.ts';

const IN_CASINO = casino.inCasino();
const REWARD = PLATFORM.deathGame.reward;

class SoundEngine {
    constructor() {
        this.ctx = null;
        this.bgmNode = null;
        this.isBgmEnabled = true;
        this.isSfxEnabled = true;
    }

    init() {
        if (!this.ctx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.ctx = new AudioContext();
        } else if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    playHover() {
        if (!this.isSfxEnabled) return;
        this.init();

        try {
            const now = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const filter = this.ctx.createBiquadFilter();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(65, now);
            osc.frequency.exponentialRampToValueAtTime(35, now + 0.12);

            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(150, now);

            gain.gain.setValueAtTime(0.025, now);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(now);
            osc.stop(now + 0.12);
        } catch (e) {
            console.warn("Audio Context error:", e);
        }
    }

    playClick() {
        if (!this.isSfxEnabled) return;
        this.init();

        try {
            const now = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const filter = this.ctx.createBiquadFilter();

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(140, now);
            osc.frequency.exponentialRampToValueAtTime(25, now + 0.18);

            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(300, now);

            gain.gain.setValueAtTime(0.05, now);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(now);
            osc.stop(now + 0.18);
        } catch (e) {
            console.warn("Audio Context error:", e);
        }
    }

    playDeepBoom() {
        if (!this.isSfxEnabled) return;
        this.init();

        try {
            const now = this.ctx.currentTime;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(90, now);
            osc.frequency.exponentialRampToValueAtTime(20, now + 0.9);

            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(now);
            osc.stop(now + 0.9);
        } catch (e) {
            console.warn("Audio Context error:", e);
        }
    }

    startAmbientDrone() {
        if (!this.isBgmEnabled || this.bgmNode) return;
        this.init();

        try {
            const now = this.ctx.currentTime;
            const osc1 = this.ctx.createOscillator();
            const osc2 = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const filter = this.ctx.createBiquadFilter();

            osc1.type = 'sawtooth';
            osc1.frequency.setValueAtTime(50, now);

            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(53.4, now);

            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(140, now);

            gain.gain.setValueAtTime(0.018, now);

            osc1.connect(filter);
            osc2.connect(filter);
            filter.connect(gain);
            gain.connect(this.ctx.destination);

            osc1.start(now);
            osc2.start(now);

            this.bgmNode = { osc1, osc2, gain };
        } catch (e) {
            console.warn("Audio Context error:", e);
        }
    }

    stopAmbientDrone() {
        if (this.bgmNode) {
            try {
                const now = this.ctx.currentTime;
                this.bgmNode.gain.gain.linearRampToValueAtTime(0.0001, now + 0.8);
                setTimeout(() => {
                    if (this.bgmNode) {
                        this.bgmNode.osc1.stop();
                        this.bgmNode.osc2.stop();
                        this.bgmNode = null;
                    }
                }, 800);
            } catch (e) {
                this.bgmNode = null;
            }
        }
    }
}

const sound = new SoundEngine();

/**
 * 60FPS TARGETED DELTA-TIME CANVAS ANIMATION
 */
const canvas = document.getElementById('dustCanvas');
const ctx = canvas.getContext('2d', { alpha: true });
const TWO_PI = Math.PI * 2;
let animationFrameId = null;
let lastTime = performance.now();
let isTabActive = true;

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas, { passive: true });
resizeCanvas();

const dustParticles = Array.from({ length: 40 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    size: Math.random() * 1.8 + 0.4,
    speedX: (Math.random() - 0.5) * 15,
    speedY: ((Math.random() - 0.5) * 9) - 4.8,
    opacity: Math.random() * 0.4 + 0.08
}));

function animateDust(currentTime) {
    if (!isTabActive) return;

    // Delta time calculation for smooth 60FPS pacing
    let dt = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    // Cap delta time to prevent position spikes after tab freeze
    if (dt > 0.1) dt = 0.016;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < dustParticles.length; i++) {
        const p = dustParticles[i];
        p.x += p.speedX * dt;
        p.y += p.speedY * dt;

        if (p.x < 0) p.x = canvas.width;
        else if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        else if (p.y > canvas.height) p.y = 0;

        ctx.fillStyle = `rgba(220, 225, 235, ${p.opacity})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, TWO_PI);
        ctx.fill();
    }

    animationFrameId = requestAnimationFrame(animateDust);
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        isTabActive = false;
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
    } else {
        isTabActive = true;
        lastTime = performance.now();
        animationFrameId = requestAnimationFrame(animateDust);
    }
});

// Register multiple games under the same stage ID. Empty stages are skipped automatically.
class DeathGameFramework {
    constructor() {
        // 각 스테이지별 게임 모듈들을 저장하는 Map 구조 (stage_1 ~ stage_5)
        this.stages = new Map();
        this.currentStageId = null;
        this.activeModule = null;
        this.container = document.getElementById('stageContainer');
        this.gameScreen = document.getElementById('gameScreen');
        // 1~5 스테이지 순차적 정의
        this.stageOrder = ['stage_1', 'stage_2', 'stage_3', 'stage_4', 'stage_5'];
        this.exitTimer = null;
        this.run = null; // the server's run (casino): every cleared stage is reported to it
        this.busy = false; // talking to the server
    }

    registerStage(stageId, stageModule) {
        if (!stageModule || typeof stageModule.init !== 'function') throw new Error('게임 init 함수가 필요합니다.');
        if (!this.stages.has(stageId)) this.stages.set(stageId, []);
        const pool = this.stages.get(stageId);
        if (!pool.includes(stageModule)) pool.push(stageModule);
    }

    clearActive() {
        if(this.activeModule && this.activeModule.destroy) this.activeModule.destroy();
        this.activeModule = null;
        this.container.innerHTML = '';
    }

    async startRun() {
        if (this.busy) return;
        clearTimeout(this.resultTimer);
        this.run = null;
        if (IN_CASINO) {
            this.showScreen();
            this.showNotice('도전을 기록하는 중…');
            this.busy = true;
            try {
                this.run = await this.withServer(() => casino.deathStart());
            } catch (e) {
                this.showProblem(e.message, '메인으로', () => this.returnToTitle());
                return;
            } finally {
                this.busy = false;
            }
        }
        this.startedAt = Date.now();
        this.clearedCount = 0;
        this.runEnded = false;
        this.loadFromIndex(0);
    }

    async nextStage() {
        if(this.runEnded || this.busy) return;
        const index = this.stageOrder.indexOf(this.currentStageId);
        if (IN_CASINO) {
            // The stage stays on screen until the server has it; a definite no ends the run.
            this.busy = true;
            try {
                await this.withServer(() => casino.deathStage(this.run, index + 1));
            } catch (e) {
                this.runEnded = true;
                this.clearActive();
                this.showProblem(e.message, '처음부터 다시', () => this.startRun());
                return;
            } finally {
                this.busy = false;
            }
        }
        this.clearedCount = (this.clearedCount || 0) + 1;
        this.loadFromIndex(index + 1);
    }

    /** Runs a server call; while the server cannot be reached it asks whether to try again (or rejects). */
    async withServer(call) {
        for (;;) {
            try {
                return await call();
            } catch (e) {
                if (!(e instanceof casino.CasinoError) || e.code !== 'network') throw e;
                const again = await new Promise(resolve => {
                    this.clearActive();
                    this.showProblem('서버에 연결할 수 없습니다. 인터넷 연결을 확인하고 다시 보내세요.', '다시 보내기', () => resolve(true), () => resolve(false));
                });
                if (!again) throw new Error('도전이 중단되었습니다.');
                this.showNotice('다시 보내는 중…');
            }
        }
    }

    showScreen() {
        clearTimeout(this.exitTimer);
        this.gameScreen.classList.remove('hidden');
        requestAnimationFrame(() => this.gameScreen.classList.remove('opacity-0'));
    }

    showNotice(text) {
        this.container.innerHTML = `
            <section class="memory-panel text-center" aria-live="polite">
                <div class="memory-eyebrow">THE FINAL SEAT / SYSTEM</div>
                <p class="memory-intro mt-3" id="noticeText"></p>
            </section>`;
        this.container.querySelector('#noticeText').textContent = text;
    }

    /** A message with one action, and 메인으로 (or `onCancel`) beside it. */
    showProblem(text, label, onAction, onCancel = () => this.returnToTitle()) {
        this.container.innerHTML = `
            <section class="memory-panel text-center" role="alert">
                <div class="memory-eyebrow">THE FINAL SEAT / SYSTEM</div>
                <h2 class="font-cinzel text-rose-400">NOTICE</h2>
                <p class="memory-intro mt-3" id="problemText"></p>
                <div class="memory-actions w-full max-w-sm mt-8">
                    <button id="problemAction" class="btn-death py-3 px-6 rounded text-zinc-100 font-bold"></button>
                    <button id="problemCancel" class="btn-death py-3 px-6 rounded text-zinc-400">메인으로</button>
                </div>
            </section>`;
        this.container.querySelector('#problemText').textContent = text;
        const action = this.container.querySelector('#problemAction');
        action.textContent = label;
        action.onclick = onAction;
        const cancel = this.container.querySelector('#problemCancel');
        cancel.hidden = label === '메인으로';
        cancel.onclick = onCancel;
    }

    showStageIntro() {
        const stageNumber = this.stageOrder.indexOf(this.currentStageId) + 1;
        this.container.innerHTML = `
            <section class="memory-panel text-center" aria-label="스테이지 시작 안내">
                <div class="memory-eyebrow">THE FINAL SEAT / STAGE ${String(stageNumber).padStart(2, '0')} / BRIEFING</div>
                <h2 id="stageIntroName" class="font-cinzel"></h2>
                <p class="memory-intro mt-3">다음 관문으로 이동하십시오.</p>
                <div class="memory-actions w-full max-w-sm mt-8">
                    <button id="btnBeginStage" class="btn-death py-3 px-6 rounded text-zinc-100 font-bold">시작하기</button>
                </div>
            </section>`;
        this.container.querySelector('#stageIntroName').textContent = this.activeModule.name;
        this.container.querySelector('#btnBeginStage').onclick = () => this.startActiveStage();
    }

    startActiveStage() {
        if (this.runEnded || !this.currentStageId || !this.activeModule) return;
        this.activeModule.init(this.container, this);
    }

    loadFromIndex(index) {
        this.clearActive();
        this.showScreen();

        // 해당 스테이지에 게임이 없을 경우 자동으로 다음 스테이지로 스킵
        for(let i = index; i < this.stageOrder.length; i++) {
            const id = this.stageOrder[i];
            const pool = this.stages.get(id) || [];
            if(!pool.length) continue; // 게임이 없는 스테이지는 자동 스킵
            
            this.currentStageId = id;
            this.activeModule = pool[Math.floor(Math.random() * pool.length)];
            this.showStageIntro();
            return;
        }

        // 5스테이지까지 모두 통과한 경우 엔딩
        this.currentStageId = null;
        if (IN_CASINO) {
            this.claimReward();
            return;
        }
        this.container.innerHTML = `
            <section class="memory-panel text-center">
                <div class="memory-eyebrow">THE FINAL SEAT / VICTORY</div>
                <h2 class="text-4xl font-black text-amber-500 my-4 font-cinzel">ALL STAGES CLEARED</h2>
                <p class="text-zinc-300 text-sm mb-6 leading-relaxed">
                    축하합니다. 어둠 속에서 끝까지 살아남아 모든 관문을 통과했습니다.<br>
                    마지막 의자의 주인은 당신입니다.
                </p>
                <div class="memory-actions">
                    <button id="runAgain" class="btn-death py-3 px-6 rounded text-zinc-200">처음부터 다시</button>
                    <button id="runExit" class="btn-death py-3 px-6 rounded text-zinc-400">메인으로</button>
                </div>
            </section>`;
        this.container.querySelector('#runAgain').onclick = () => this.startRun();
        this.container.querySelector('#runExit').onclick = () => this.returnToTitle();
    }

    /** All five stages reported: the reward goes to the balance (the same key if the answer was lost). */
    async claimReward() {
        this.runEnded = true;
        const key = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
        this.busy = true;
        this.showVictory('보상을 받는 중…');
        try {
            await this.withServer(() => casino.deathClear(this.run, key));
            this.showVictory(`${REWARD}칩이 잔고에 들어갔습니다!`);
            sound.playDeepBoom();
        } catch (e) {
            this.showVictory(e.message);
        } finally {
            this.busy = false;
            this.run = null;
        }
    }

    showVictory(status) {
        this.container.innerHTML = `
            <section class="memory-panel text-center">
                <div class="memory-eyebrow">THE FINAL SEAT / VICTORY</div>
                <h2 class="text-4xl font-black text-amber-500 my-4 font-cinzel">ALL STAGES CLEARED</h2>
                <p class="text-zinc-300 text-sm mb-4 leading-relaxed">
                    축하합니다. 어둠 속에서 끝까지 살아남아 모든 관문을 통과했습니다.<br>
                    마지막 의자의 주인은 당신입니다.
                </p>
                <p id="rewardStatus" class="text-lg font-bold text-amber-300 mb-6" role="status" aria-live="polite" data-testid="death-reward-status"></p>
                <div class="memory-actions">
                    <button id="runExit" class="btn-death py-3 px-6 rounded text-zinc-100 font-bold" data-testid="death-exit">로비로</button>
                </div>
            </section>`;
        this.container.querySelector('#rewardStatus').textContent = status;
        const exit = this.container.querySelector('#runExit');
        exit.disabled = this.busy && status === '보상을 받는 중…';
        exit.onclick = () => casino.exit();
    }

    gameOver(reason, detail = '') {
        if(this.runEnded) return;
        this.runEnded = true;
        const stage = this.currentStageId;
        const gameName = this.activeModule?.name || stage;
        this.clearActive();
        const elapsed = Math.floor((Date.now() - (this.startedAt || Date.now())) / 1000);
        this.container.innerHTML = `
            <section class="memory-panel result-screen" role="status" aria-live="polite">
                <div class="memory-eyebrow">THE FINAL SEAT / RESULT</div>
                <h2>GAME OVER</h2>
                <p class="result-reason"></p>
                <dl class="result-details">
                    <dt>실패한 게임</dt><dd id="resultGame"></dd>
                    <dt>통과한 관문</dt><dd>${this.clearedCount || 0}개</dd>
                    <dt>플레이 시간</dt><dd>${Math.floor(elapsed / 60)}분 ${elapsed % 60}초</dd>
                    <dt>결과</dt><dd id="resultDetail"></dd>
                </dl>
                <p id="resultCountdown">6초 후 메인 화면으로 돌아갑니다.</p>
            </section>`;
        this.container.querySelector('.result-reason').textContent = reason;
        this.container.querySelector('#resultGame').textContent = gameName;
        this.container.querySelector('#resultDetail').textContent = detail || '관문 실패';
        
        let seconds = 6;
        const tick = () => {
            seconds--;
            if(seconds <= 0) { this.returnToTitle(); return; }
            const cd = this.container.querySelector('#resultCountdown');
            if (cd) cd.textContent = `${seconds}초 후 메인 화면으로 돌아갑니다.`;
            this.resultTimer = setTimeout(tick, 1000);
        };
        this.resultTimer = setTimeout(tick, 1000);
    }

    returnToTitle() {
        clearTimeout(this.resultTimer);
        this.clearActive();
        this.currentStageId = null;
        this.gameScreen.classList.add('opacity-0');
        clearTimeout(this.exitTimer);
        this.exitTimer = setTimeout(() => this.gameScreen.classList.add('hidden'), 300);
    }
}

const GameFramework = new DeathGameFramework();

const PoisonStage1 = {
    name: '제1관문: 단서로 독 잔 찾기',
    init(container, framework) {
        this.destroy(); this.alive = true; this.locked = false; this.mistakes = 0;
        this.poisonIndex = Math.floor(Math.random() * 6);
        const poisonNumber = this.poisonIndex + 1;
        this.clues = this.createClues(poisonNumber);
        container.innerHTML = `<section class="memory-panel poison-panel">
          <div class="memory-eyebrow">THE FINAL SEAT / STAGE 01</div>
          <h2>단서로 독 잔 찾기</h2>
          <p class="memory-intro">네 가지 분석 기록에서 독이 든 잔을 찾아라.</p>
          <div class="w-full max-w-6xl overflow-x-auto my-3"><div class="grid grid-cols-4 min-w-[760px] gap-3">${this.clues.map((clue,i)=>`<div class="bg-zinc-900/80 border border-zinc-700 rounded p-3 text-left"><span class="text-[10px] font-mono text-amber-400">분석 단서 0${i+1}</span><p class="text-sm text-zinc-200 mt-1">${clue}</p></div>`).join('')}</div></div>
          <p class="poison-rules">여섯 잔 중 하나가 독 잔입니다. 네 단서 중 정확히 하나는 거짓입니다.<br>나머지 세 단서만 만족하는 잔을 찾으세요.<br><small>오답은 두 번까지 허용됩니다.</small></p>
          <div class="poison-grid">${Array.from({length:6},(_,i)=>`<button type="button" class="poison-cup" data-cup="${i}" aria-label="${i+1}번 잔 선택"><svg aria-hidden="true" viewBox="0 0 100 110"><path d="M24 20 L31 94 Q50 104 69 94 L76 20" fill="#cdefff10" stroke="#a6c4d4" stroke-width="2"/><path class="cup-water" d="M28 48 Q50 43 72 48 L67 91 Q50 98 33 91 Z" fill="#70c9eb66"/><path d="M24 20 Q50 27 76 20 M31 29 L35 72" fill="none" stroke="#d9f5ff" stroke-width="2" opacity=".6"/></svg><span>${String(i+1).padStart(2,'0')}</span><small class="cup-label">선택하기</small></button>`).join('')}</div>
          <p id="poisonStatus" role="status" aria-live="polite">단서를 비교해 잔을 선택하세요. 오답은 두 번까지 허용됩니다.</p>
        </section>`;
        this.cups = [...container.querySelectorAll('[data-cup]')];
        this.cups.forEach((cup,i) => cup.onclick = () => this.choose(i, container, framework));
    },
    createClues(secret) {
        const predicates = [
            { matches: n => n % 2 === 0, text: truth => truth ? '독 잔 번호는 짝수입니다.' : '독 잔 번호는 홀수입니다.' },
            { matches: n => n <= 3, text: truth => truth ? '독 잔은 1~3번 중 하나입니다.' : '독 잔은 4~6번 중 하나입니다.' },
            { matches: n => [2, 3, 5].includes(n), text: truth => truth ? '독 잔 번호는 소수입니다.' : '독 잔 번호는 소수가 아닙니다.' },
            { matches: n => n % 3 === 0, text: truth => truth ? '독 잔 번호는 3의 배수입니다.' : '독 잔 번호는 3의 배수가 아닙니다.' }
        ];
        for (let anchor = 1; anchor <= 6; anchor++) {
            predicates.push({
                matches: n => Math.abs(n - anchor) === 1,
                text: truth => truth ? `독 잔은 ${anchor}번 잔의 바로 옆입니다.` : `독 잔은 ${anchor}번 잔의 바로 옆이 아닙니다.`
            });
        }
        for (let threshold = 1; threshold <= 5; threshold++) {
            predicates.push({
                matches: n => n > threshold,
                text: truth => truth ? `독 잔 번호는 ${threshold}번보다 큽니다.` : `독 잔 번호는 ${threshold}번 이하입니다.`
            });
        }

        const values = [1, 2, 3, 4, 5, 6];
        const shuffled = predicates.sort(() => Math.random() - 0.5);
        for (let a = 0; a < shuffled.length - 3; a++) {
            for (let b = a + 1; b < shuffled.length - 2; b++) {
                for (let c = b + 1; c < shuffled.length - 1; c++) {
                    for (let d = c + 1; d < shuffled.length; d++) {
                        const group = [shuffled[a], shuffled[b], shuffled[c], shuffled[d]];
                        for (let lie = 0; lie < group.length; lie++) {
                            const clues = group.map((clue, index) => {
                                const truth = clue.matches(secret) !== (index === lie);
                                return { text: clue.text(truth), matches: value => clue.matches(value) === truth };
                            });
                            const solutions = values.filter(value => clues.filter(clue => clue.matches(value)).length === 3);
                            if (solutions.length === 1 && solutions[0] === secret) {
                                return clues.sort(() => Math.random() - 0.5).map(clue => clue.text);
                            }
                        }
                    }
                }
            }
        }
        throw new Error('독극물 단서 조합을 만들 수 없습니다.');
    },
    choose(index, container, framework) {
        if(!this.alive || this.locked) return;
        const cup = this.cups[index];
        if (cup.disabled) return;
        if(index === this.poisonIndex) {
            this.locked = true;
            this.cups.forEach((item,i) => {
                item.disabled = true;
                item.classList.add(i === this.poisonIndex ? 'poison-reveal' : 'safe-reveal');
                item.querySelector('.cup-label').textContent = i === this.poisonIndex ? '독 잔 발견' : '안전 확인';
            });
            container.querySelector('#poisonStatus').textContent = '분석 성공. 독 잔을 찾아냈습니다. 다음 관문으로 이동합니다.';
            sound.playClick();
            this.timer = setTimeout(() => { if(this.alive) framework.nextStage(); }, 1800);
        } else {
            this.mistakes++;
            cup.disabled = true;
            cup.classList.add('chosen', 'safe-reveal');
            cup.querySelector('.cup-label').textContent = '안전 확인';
            if(this.mistakes >= 3) {
                this.locked = true;
                this.cups.forEach((item,i) => {
                    item.disabled = true;
                    if(i === this.poisonIndex) {
                        item.classList.add('poison-reveal');
                        item.querySelector('.cup-label').textContent = '독 잔';
                    }
                });
                sound.playDeepBoom();
                framework.gameOver('독 잔을 찾지 못했습니다.', '오답 기회 소진');
            } else {
                container.querySelector('#poisonStatus').textContent = `안전한 잔입니다. 단서를 다시 살펴보세요. 남은 오답 기회 ${3 - this.mistakes}회.`;
                sound.playClick();
            }
        }
    },
    destroy() { this.alive = false; clearTimeout(this.timer); this.timer = null; }
};
GameFramework.registerStage('stage_1', PoisonStage1);

const CodeBreakerStage1 = {
    name: '제1관문: 봉인 암호 해독',
    codeLength: 4,
    maxAttempts: 6,
    init(container, framework) {
        this.destroy();
        this.alive = true;
        this.locked = false;
        this.framework = framework;
        this.attempts = 0;
        this.code = [...Array(9)].map((_, i) => i + 1)
            .sort(() => Math.random() - 0.5)
            .slice(0, this.codeLength);

        container.innerHTML = `
        <section class="memory-panel" aria-label="제1관문 암호 추리 게임">
          <div class="memory-eyebrow">THE FINAL SEAT / STAGE 01</div>
          <h2>봉인 암호 해독</h2>
                            <p class="memory-intro">네 자리 숫자에 숨겨진 탈출 암호를 찾아라.</p>
                            <p class="poison-rules">1부터 9까지, 중복 없는 네 숫자의 순서를 맞히세요.<br>최대 ${this.maxAttempts}번의 기회가 주어집니다.<br><small>숫자와 자리까지 맞으면 '정확', 숫자만 맞으면 '숫자 포함'으로 표시됩니다.</small></p>
                            <div class="w-full max-w-xl my-5">
                                <div id="codePositions" class="grid grid-cols-4 gap-2" role="group" aria-label="수정할 암호 자리">
                                    ${Array.from({length:this.codeLength},(_,i)=>`<button type="button" class="code-position-option rounded-lg border border-zinc-700 bg-zinc-900/80 p-2 text-center" data-position="${i}" aria-pressed="${i===0}" aria-label="${i+1}번째 자리, 숫자 ${i+1}"><span class="block text-[10px] font-mono text-zinc-500">자리 0${i+1}</span><strong data-position-value class="text-xl">${i+1}</strong></button>`).join('')}
                                </div>
                                <p id="codePickerStatus" class="my-2 text-xs text-zinc-400" aria-live="polite">수정할 자리를 고른 뒤 아래 숫자를 선택하세요.</p>
                                <div id="codeDigitRail" class="code-number-rail mx-auto w-full max-w-[400px]" role="group" aria-label="가로 스크롤 숫자 선택">
                                    ${Array.from({length:9},(_,i)=>i+1).map(number=>`<button type="button" class="code-number-option" data-number="${number}" aria-pressed="${number===1}">${number}</button>`).join('')}
                                </div>
                            </div>
          <button id="codeGuess" class="btn-death w-full max-w-sm py-3 rounded text-zinc-100 font-bold">암호 제출</button>
          <p id="codeStatus" class="my-3 text-sm text-zinc-300" role="status" aria-live="polite">암호를 추리해 제출하세요.</p>
                            <div class="w-full max-w-2xl mt-2 border-t border-zinc-800 pt-3">
                                <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
                                    <h3 class="text-sm sm:text-base font-bold text-zinc-200">추측 기록</h3>
                                    <div class="flex flex-wrap gap-2 text-[10px] sm:text-xs"><span class="text-emerald-300">초록: 숫자와 자리 정확</span><span class="text-amber-300">호박: 숫자만 포함</span><span class="text-zinc-500">회색: 암호에 없음</span></div>
                                </div>
                                <ol id="codeHistory" class="max-h-[32dvh] overflow-y-auto space-y-2 text-sm text-left" aria-label="이전 추측"></ol>
                            </div>
        </section>`;

        this.status = container.querySelector('#codeStatus');
        this.history = container.querySelector('#codeHistory');
        this.selectedDigits = Array.from({length:this.codeLength},(_,i)=>i+1);
        this.activePosition = 0;
        this.pickerStatus = container.querySelector('#codePickerStatus');
        this.positionButtons = [...container.querySelectorAll('[data-position]')];
        this.numberButtons = [...container.querySelectorAll('[data-number]')];
        this.positionButtons.forEach(button => button.onclick = () => {
            this.activePosition = Number(button.dataset.position);
            this.updatePicker();
        });
        this.numberButtons.forEach(button => button.onclick = () => this.chooseDigit(Number(button.dataset.number)));
        this.updatePicker();
        container.querySelector('#codeGuess').onclick = () => this.submitGuess();
    },
    updatePicker() {
        this.positionButtons.forEach((button,index) => {
            const isActive = index === this.activePosition;
            button.setAttribute('aria-pressed', String(isActive));
            button.querySelector('[data-position-value]').textContent = this.selectedDigits[index];
            button.setAttribute('aria-label', `${index+1}번째 자리, 숫자 ${this.selectedDigits[index]}${isActive ? ', 선택됨' : ''}`);
        });
        this.numberButtons.forEach(button => {
            const number = Number(button.dataset.number);
            const selectedAt = this.selectedDigits.indexOf(number);
            button.setAttribute('aria-pressed', String(this.selectedDigits[this.activePosition] === number));
            button.classList.toggle('is-used', selectedAt !== -1 && selectedAt !== this.activePosition);
            button.setAttribute('aria-label', `${number}${selectedAt !== -1 && selectedAt !== this.activePosition ? ', 다른 자리에 사용 중, 선택하면 자리 교환' : ''}`);
        });
    },
    chooseDigit(number) {
        const duplicateIndex = this.selectedDigits.indexOf(number);
        if (duplicateIndex !== -1) {
            if (duplicateIndex !== this.activePosition) {
                this.selectedDigits[duplicateIndex] = this.selectedDigits[this.activePosition];
                this.pickerStatus.textContent = `${this.activePosition+1}번째와 ${duplicateIndex+1}번째 자리의 숫자를 서로 바꿨습니다.`;
            } else {
                this.pickerStatus.textContent = `${this.activePosition+1}번째 자리의 숫자를 선택했습니다.`;
            }
        } else {
            this.pickerStatus.textContent = `${this.activePosition+1}번째 자리의 숫자를 선택했습니다.`;
        }
        this.selectedDigits[this.activePosition] = number;
        this.updatePicker();
    },
    submitGuess() {
        if (!this.alive || this.locked) return;
        const guess = this.selectedDigits;
        if (new Set(guess).size !== guess.length) {
            this.status.textContent = `서로 다른 숫자 ${this.codeLength}개를 선택하세요.`;
            return;
        }

        this.attempts++;
        const exact = guess.filter((digit, index) => digit === this.code[index]).length;
        const included = guess.filter(digit => this.code.includes(digit)).length - exact;
        const row = document.createElement('li');
        row.className = 'rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-3 sm:px-4';
        const digits = guess.map((digit,index) => {
            const isExact = digit === this.code[index];
            const isIncluded = this.code.includes(digit);
            const color = isExact ? 'bg-emerald-400 text-zinc-950' : isIncluded ? 'bg-amber-300 text-zinc-950' : 'bg-zinc-700 text-zinc-200';
            const label = isExact ? '정확' : isIncluded ? '숫자 포함' : '암호에 없음';
            return `<span class="inline-flex h-9 w-9 items-center justify-center rounded-md ${color} font-black" aria-label="${index+1}번째 숫자 ${digit}: ${label}">${digit}</span>`;
        }).join('');
        row.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-3"><div class="flex items-center gap-3"><span class="text-xs font-mono text-zinc-500">시도 ${this.attempts}</span><div class="flex gap-1.5">${digits}</div></div><div class="flex gap-2 text-xs font-bold"><span class="rounded bg-emerald-950 px-2 py-1 text-emerald-300">정확 ${exact}</span><span class="rounded bg-amber-950 px-2 py-1 text-amber-300">포함 ${included}</span></div></div>`;
        this.history.prepend(row);

        if (exact === this.code.length) {
            this.locked = true;
            this.status.textContent = '암호 해독 성공. 다음 관문으로 이동합니다.';
            sound.playClick();
            this.timer = setTimeout(() => {
                if (this.alive) this.framework.nextStage();
            }, 1400);
        } else if (this.attempts >= this.maxAttempts) {
            this.locked = true;
            sound.playDeepBoom();
            this.framework.gameOver('봉인 암호 해독에 실패했습니다.', `${this.maxAttempts}번의 기회 소진`);
        } else {
            this.status.textContent = `${this.maxAttempts - this.attempts}번의 기회가 남았습니다.`;
            sound.playClick();
        }
    },
    destroy() {
        this.alive = false;
        clearTimeout(this.timer);
        this.timer = null;
    }
};
GameFramework.registerStage('stage_1', CodeBreakerStage1);

// STAGE 02 · Memory sequence module. Adjust targetRounds to change difficulty.
const MemoryStage2 = {
    name: '제 2 관문: 불빛 암기',
    targetRounds: 5,
    maxLives: 3,
    init(container, framework) {
        this.destroy();
        this.alive = true;
        this.timers = new Set();
        this.sequence = [];
        this.lives = this.maxLives; this.round = 0;
        this.position = 0;
        this.phase = 'ready';
        container.innerHTML = `
        <section class="memory-panel" aria-label="제2관문 기억력 게임">
          <div class="memory-eyebrow">THE FINAL SEAT / STAGE 02</div>
          <h2>불빛 암기</h2>
          <p class="memory-intro">빛은 사라져도, 순서는 남는다.</p>
          <div id="memoryLives" aria-live="polite">목숨 ${'♥ '.repeat(this.maxLives)}</div><div class="memory-stats"><span id="memoryRound">ROUND 0 / ${this.targetRounds}</span><span id="memoryProgress">입력 0 / 0</span></div>
          <p id="memoryStatus" role="status" aria-live="polite">불빛의 순서를 기억하고 그대로 누르세요.</p>
          <div class="memory-grid">${['청록','호박','보라','장미','하늘','연두','주황','분홍','흰색'].map((name,i)=>`<button class="memory-pad pad-${i}" data-pad="${i}" disabled aria-label="${i+1}번 ${name} 버튼"><span>0${i+1}</span><small>${['Q','W','E','A','S','D','Z','X','C'][i]}</small></button>`).join('')}</div>
          <p class="memory-help">마우스 · 터치 · QWE / ASD / ZXC 또는 숫자 1–9<br>목숨 ${this.maxLives}개 · 총 ${this.targetRounds}라운드 · 순서 3개부터 시작<br>매 라운드 1개 추가 · 불빛 가속 · 오답 시 같은 순서 재도전</p>
          <div class="memory-actions"><button id="memoryStart">기억 시험 시작</button></div>
        </section>`;
        this.framework = framework;
        this.root = container;
        this.pads = [...container.querySelectorAll('[data-pad]')];
        this.status = container.querySelector('#memoryStatus');
        this.startButton = container.querySelector('#memoryStart');
        this.pads.forEach((pad,i) => pad.onclick = () => this.press(i));
        this.startButton.onclick = () => this.start();

        this.keyHandler = e => {
            if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
            const i = ({q:0,w:1,e:2,a:3,s:4,d:5,z:6,x:7,c:8,'1':0,'2':1,'3':2,'4':3,'5':4,'6':5,'7':6,'8':7,'9':8})[e.key.toLowerCase()];
            if (i !== undefined) { e.preventDefault(); this.press(i); }
        };
        window.addEventListener('keydown', this.keyHandler);
    },
    later(fn,ms) {
        const id = setTimeout(() => { this.timers.delete(id); if(this.alive) fn(); },ms);
        this.timers.add(id); return id;
    },
    cancelTimers() { if(this.timers) { this.timers.forEach(clearTimeout); this.timers.clear(); } },
    enablePads(enabled) { this.pads.forEach(p => p.disabled = !enabled); },
    tone(i) {
        if(!sound.isSfxEnabled) return;
        try {
            sound.init(); const ctx = sound.ctx;
            if(ctx.state === 'suspended') ctx.resume().catch(()=>{});
            const o=ctx.createOscillator(), g=ctx.createGain(), now=ctx.currentTime;
            o.type='sine'; o.frequency.value=[261.63,293.66,329.63,349.23,392,440,493.88,523.25,587.33][i];
            g.gain.setValueAtTime(0,now); g.gain.linearRampToValueAtTime(.075,now+.015);
            g.gain.exponentialRampToValueAtTime(.0001,now+.28);
            o.connect(g);g.connect(ctx.destination);o.start();o.stop(now+.3);
        } catch(e) { /* Audio is optional. */ }
    },
    flash(i,duration=360) {
        const pad=this.pads[i];
        if(pad._off) { clearTimeout(pad._off); this.timers.delete(pad._off); }
        pad.classList.add('lit'); this.tone(i);
        pad._off=this.later(()=>{pad.classList.remove('lit');pad._off=null;},duration);
    },
    start() {
        if(!this.alive || ['watch','input','transition'].includes(this.phase)) return;
        this.cancelTimers();this.sequence=[];this.position=0;this.lives=this.maxLives;this.round=0;
        this.root.querySelector("#memoryLives").textContent="목숨 "+"♥ ".repeat(this.maxLives);
        this.pads.forEach(p=>p.classList.remove('lit'));
        this.startButton.disabled=true;this.startButton.textContent='시험 진행 중';
        this.nextRound();
    },
    nextRound(retry=false) {
        this.phase='watch';this.enablePads(false);this.position=0;
        if(!retry) { this.round++; const count=this.round===1?3:1; for(let n=0;n<count;n++) this.sequence.push(Math.floor(Math.random()*9)); }
        this.root.querySelector('#memoryRound').textContent=`ROUND ${this.round} / ${this.targetRounds}`;
        this.root.querySelector('#memoryProgress').textContent=`입력 0 / ${this.sequence.length}`;
        this.status.textContent='관찰 — 불빛의 순서를 기억하세요.';
        const step=Math.max(400,620-(this.round-1)*40);
        const startDelay=520;
        this.sequence.forEach((value,i)=>this.later(()=>this.flash(value,Math.round(step*.62)),startDelay+i*step));
        this.later(()=>{
            this.phase='input';this.enablePads(true);
            this.status.textContent='입력 — 기억한 순서대로 누르세요.';
        },startDelay+this.sequence.length*step);
    },
    press(i) {
        if(!this.alive || this.phase!=='input') return;
        this.flash(i,180);
        if(i!==this.sequence[this.position]) { this.loseLife();return; }
        this.position++;
        this.root.querySelector('#memoryProgress').textContent=`입력 ${this.position} / ${this.sequence.length}`;
        if(this.position===this.sequence.length) {
            this.enablePads(false);this.phase='transition';
            if(this.round===this.targetRounds) {this.finish(true);return;}
            this.status.textContent='일치 확인. 다음 기억을 준비하세요.';
            this.later(()=>this.nextRound(),1000);
        }
    },
    loseLife() {
        this.phase='transition'; this.enablePads(false); this.cancelTimers();
        this.pads.forEach(p=>p.classList.remove('lit'));
        this.lives--;
        this.root.querySelector('#memoryLives').textContent='목숨 '+ '♥ '.repeat(this.lives)+'♡ '.repeat(this.maxLives-this.lives);
        if(this.lives===0) {this.finish(false); return;}
        sound.playDeepBoom();
        this.status.textContent=`순서 불일치 — 목숨 ${this.lives}개. 같은 순서를 다시 보여드립니다.`;
        this.later(()=>this.nextRound(true),1400);
    },
    finish(won) {
        if(!won) { sound.playDeepBoom(); this.framework.gameOver('기억 시험에서 목숨을 모두 잃었습니다.',`${this.round} / ${this.targetRounds}라운드 · 남은 목숨 0개`); return; }
        this.phase=won?'won':'lost';this.enablePads(false);
        this.status.textContent=won?'생존 확인 — 제2관문을 통과했습니다.':'목숨 소진 — 관문 실패.';
        this.startButton.disabled=false;this.startButton.textContent=won?'다음 관문으로':'처음부터 재도전';
        this.startButton.onclick=won?()=>this.framework.nextStage():()=>this.start();
        if(!won) sound.playDeepBoom();
    },
    destroy() {
        this.alive=false;this.cancelTimers();
        if(this.keyHandler) window.removeEventListener('keydown',this.keyHandler);
        this.keyHandler=null;
    }
};
GameFramework.registerStage('stage_2', MemoryStage2);

const IndianPokerBetStage3 = {
    name: '제3관문: 인디언 포커',
    init(container, framework) {
        this.destroy();
        this.alive = true;
        this.framework = framework;
        this.container = container;
        this.playerLives = 5;
        this.dealerLives = 4;
        this.turn = 'player';
        this.timers = new Set();
        this.render();
    },
    render() {
        if (!this.alive) return;
        this.container.innerHTML = `
                        <section class="memory-panel" aria-label="제3관문 인디언 포커">
          <div class="memory-eyebrow">THE FINAL SEAT / STAGE 03</div>
                            <h2>인디언 포커</h2>
          <p class="memory-intro">이마에 보이는 상대 카드만으로 승부를 결정하세요.</p>
          <div class="flex items-center justify-center gap-3 rounded-lg border border-amber-700/50 bg-zinc-950/80 px-5 py-2 my-2"><span class="text-[10px] font-mono tracking-widest text-zinc-400">CARD RANGE</span><strong class="text-2xl font-black text-amber-300">1 – 15</strong><span class="text-xs text-zinc-400">판돈 1 또는 2 목숨</span></div>
          <div class="memory-stats" style="margin: 12px 0; font-size:13px;"><span>내 목숨: <strong id="betPlayerLives" style="color:#ff7b9c"></strong></span><span>딜러 목숨: <strong id="betDealerLives" style="color:#78caff"></strong></span></div>
          <div class="w-full max-w-xl bg-zinc-950/80 border border-zinc-800 rounded-lg p-5 my-2 text-center">
            <p id="betTurnTitle" class="text-xs font-bold text-rose-300 mb-2"></p>
            <div id="betCard" class="text-5xl font-black font-cinzel text-amber-300">?</div>
            <p id="betStatus" class="text-sm text-zinc-300 mt-3 min-h-12" role="status" aria-live="polite"></p>
          </div>
          <div class="grid grid-cols-3 gap-2 w-full max-w-xl mt-3">
            <button id="betAction1" class="btn-death py-3 rounded text-xs sm:text-sm">콜 · 1 목숨</button>
            <button id="betAction2" class="btn-death py-3 rounded text-xs sm:text-sm">콜 · 2 목숨</button>
            <button id="betAction3" class="btn-death py-3 rounded text-xs sm:text-sm">다이</button>
          </div>
          <p class="memory-help">플레이어 차례에는 판돈을 정해 콜하거나 다이하세요. 딜러가 콜하면 받아들이거나 다이할 수 있습니다 (다이해도 목숨을 잃지 않습니다).</p>
        </section>`;
        this.playerLivesEl = this.container.querySelector('#betPlayerLives');
        this.dealerLivesEl = this.container.querySelector('#betDealerLives');
        this.turnTitleEl = this.container.querySelector('#betTurnTitle');
        this.cardEl = this.container.querySelector('#betCard');
        this.statusEl = this.container.querySelector('#betStatus');
        this.actions = [1,2,3].map(index => this.container.querySelector(`#betAction${index}`));
        this.updateLives();
        if (this.turn === 'player') this.setupPlayerTurn();
        else this.setupDealerTurn();
    },
    randomCard() { return Math.floor(Math.random() * 15) + 1; },
    updateLives() {
        this.playerLivesEl.textContent = '♥ '.repeat(this.playerLives);
        this.dealerLivesEl.textContent = '♥ '.repeat(this.dealerLives);
    },
    setupPlayerTurn() {
        this.playerCard = this.randomCard();
        this.dealerCard = this.randomCard();
        this.turnTitleEl.textContent = '나의 차례 · 딜러의 이마 카드';
        this.cardEl.textContent = this.dealerCard;
        this.statusEl.textContent = '내 카드는 보이지 않습니다. 공개된 카드보다 높을지 추리하세요.';
        this.actions.forEach(button => button.style.display = 'block');
        this.actions[0].textContent = '콜 · 1 목숨';
        this.actions[1].textContent = '콜 · 2 목숨';
        this.actions[1].disabled = this.playerLives < 2;
        this.actions[2].textContent = '다이';
        this.actions[0].disabled = false;
        this.actions[2].disabled = false;
        this.actions[0].onclick = () => this.resolvePlayerTurn(false, 1);
        this.actions[1].onclick = () => this.resolvePlayerTurn(false, 2);
        this.actions[2].onclick = () => this.resolvePlayerTurn(true);
    },
    resolvePlayerTurn(isFold, stake = 1) {
        if (!this.alive) return;
        this.actions.forEach(button => button.disabled = true);
        if (isFold) {
            sound.playClick();
            this.statusEl.textContent = '다이를 선택했습니다. 목숨 손실 없이 딜러 차례로 넘어갑니다.';
            this.finishHand('dealer');
            return;
        }
        const dealerFolds = this.playerCard >= 11 ? Math.random() < 0.65 : this.playerCard <= 5 ? Math.random() < 0.1 : Math.random() < 0.3;
        if (dealerFolds) {
            sound.playClick();
            this.statusEl.innerHTML = `딜러가 ${stake} 목숨 판돈에 다이했습니다. 승부 없이 목숨을 지켰습니다.`;
        } else if (this.playerCard > this.dealerCard) {
            this.dealerLives = Math.max(0, this.dealerLives - stake);
            this.updateLives();
            sound.playClick();
            this.statusEl.innerHTML = `승리! 내 카드 <strong>${this.playerCard}</strong>가 딜러 카드 <strong>${this.dealerCard}</strong>보다 높습니다.<br><span class="text-sky-300">딜러 목숨 ${stake}개 감소</span>`;
        } else if (this.playerCard < this.dealerCard) {
            this.playerLives = Math.max(0, this.playerLives - stake);
            this.updateLives();
            sound.playDeepBoom();
            this.statusEl.innerHTML = `패배. 내 카드 <strong>${this.playerCard}</strong>가 딜러 카드 <strong>${this.dealerCard}</strong>보다 낮습니다.<br><span class="text-rose-300">내 목숨 ${stake}개 감소</span>`;
        } else {
            sound.playClick();
            this.statusEl.innerHTML = `무승부! 양쪽 카드가 모두 <strong>${this.playerCard}</strong>입니다. 목숨 변화 없음.`;
        }
        this.finishHand('dealer');
    },
    setupDealerTurn() {
        this.playerCard = this.randomCard();
        this.dealerCard = this.randomCard();
        this.turnTitleEl.textContent = '딜러 차례 · 상대가 보는 내 이마 카드';
        this.cardEl.textContent = this.playerCard;
        this.statusEl.textContent = '딜러가 승부를 고민하고 있습니다. 선택을 확인하세요.';
        this.actions[0].style.display = 'block';
        this.actions[0].disabled = false;
        this.actions[0].textContent = '딜러 선택 확인';
        this.actions[0].onclick = () => this.revealDealerChoice();
        this.actions[1].style.display = 'none';
        this.actions[2].style.display = 'none';
    },
    revealDealerChoice() {
        if (!this.alive) return;
        this.actions[0].disabled = true;
        const foldChance = this.playerCard >= 11 ? 0.65 : this.playerCard <= 5 ? 0.1 : 0.3;
        if (Math.random() < foldChance) {
            sound.playClick();
            this.statusEl.textContent = '딜러가 다이했습니다. 목숨 손실 없이 내 차례로 넘어갑니다.';
            this.finishHand('player');
            return;
        }
        this.dealerStake = Math.min(this.dealerLives, Math.random() < 0.6 ? 1 : 2);
        this.statusEl.innerHTML = `딜러가 <strong>콜 · ${this.dealerStake} 목숨</strong>을 걸었습니다. 받아들이거나 다이하세요.`;
        this.actions[0].disabled = this.playerLives < this.dealerStake;
        this.actions[0].textContent = `콜 수락 · ${this.dealerStake} 목숨`;
        this.actions[0].onclick = () => this.resolveDealerCall(false);
        this.actions[1].style.display = 'none';
        this.actions[2].style.display = 'block';
        this.actions[2].disabled = false;
        this.actions[2].textContent = '다이';
        this.actions[2].onclick = () => this.resolveDealerCall(true);
    },
    resolveDealerCall(isFold) {
        if (!this.alive) return;
        this.actions.forEach(button => button.disabled = true);
        if (isFold) {
            // Free, like a fold on the player's own turn: the stage is won by reading the cards, not by luck.
            sound.playClick();
            this.statusEl.textContent = '딜러의 콜을 받지 않았습니다. 목숨 손실 없이 내 차례로 넘어갑니다.';
            this.finishHand('player');
            return;
        }
        if (this.dealerCard > this.playerCard) {
            this.playerLives = Math.max(0, this.playerLives - this.dealerStake);
            this.updateLives();
            sound.playDeepBoom();
            this.statusEl.innerHTML = `딜러 승리! 딜러 카드 <strong>${this.dealerCard}</strong>가 공개된 카드 <strong>${this.playerCard}</strong>보다 높습니다.<br><span class="text-rose-300">내 목숨 ${this.dealerStake}개 감소</span>`;
        } else if (this.dealerCard < this.playerCard) {
            this.dealerLives = Math.max(0, this.dealerLives - this.dealerStake);
            this.updateLives();
            sound.playClick();
            this.statusEl.innerHTML = `딜러 패배! 공개된 카드 <strong>${this.playerCard}</strong>가 딜러 카드 <strong>${this.dealerCard}</strong>보다 높습니다.<br><span class="text-sky-300">딜러 목숨 ${this.dealerStake}개 감소</span>`;
        } else {
            sound.playClick();
            this.statusEl.innerHTML = `무승부! 양쪽 카드가 모두 <strong>${this.playerCard}</strong>입니다. 목숨 변화 없음.`;
        }
        this.finishHand('player');
    },
    finishHand(nextTurn) {
        if (this.playerLives <= 0) {
            this.later(() => this.framework.gameOver('인디언 포커에서 목숨을 모두 잃었습니다.', '파산 · 심리전 패배'), 1500);
        } else if (this.dealerLives <= 0) {
            this.statusEl.innerHTML += '<br><strong class="text-sky-300">딜러의 목숨을 모두 빼앗았습니다. 관문 통과!</strong>';
            this.later(() => this.framework.nextStage(), 1500);
        } else {
            this.later(() => {
                this.turn = nextTurn;
                this.render();
            }, 1500);
        }
    },
    later(fn, delay) {
        const id = setTimeout(() => {
            this.timers.delete(id);
            if (this.alive) fn();
        }, delay);
        this.timers.add(id);
        return id;
    },
    destroy() {
        this.alive = false;
        if (this.timers) this.timers.forEach(clearTimeout);
        if (this.timers) this.timers.clear();
    }
};
GameFramework.registerStage('stage_3', IndianPokerBetStage3);


const BombDefusalStage4 = {
    name: '제4관문: 시한폭탄 해체',
    timeLimit: 90, // seconds for both modules

    /** The time left as m:ss. */
    clock() {
        const t = Math.max(0, this.timeLeft);
        return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    },
    init(container, framework) {
        this.timers = new Set();
        this.destroy();
        this.alive = true;
        this.framework = framework;
        this.root = container;
        this.gameStarted = false;
        this.timeLeft = this.timeLimit;
        this.currentView = 'bomb';
        this.rafId = null;
        this.isInputLocked = false;

        const allTypes = [0, 1, 2, 3].sort(() => Math.random() - 0.5).slice(0, 2);

        this.puzzles = allTypes.map(type => ({
            type: type,
            solved: false,
            data: this.createPuzzleData(type)
        }));

        this.render();
    },

    createPuzzleData(type) {
        switch(type) {
            case 0: // 전선 자르기
                let wires = ['target', 'target', 'forbidden', 'forbidden', 'neutral', 'neutral']
                    .sort(() => Math.random() - 0.5);
                return {
                    wires: wires.map(w => ({ type: w, cut: false, light: 'normal' })),
                    targetsLeft: 2
                };
            case 1: // 방향 맞추기 (10개, 혼합 힌트)
                const allHints = ['↑', '↓', '←', '→', 'W', 'A', 'S', 'D', '북', '남', '서', '동'];
                let seq = [];
                for(let i = 0; i < 10; i++) {
                    seq.push(allHints[Math.floor(Math.random() * allHints.length)]);
                }
                return { sequence: seq, currentIndex: 0 };
            case 2: // 타이밍 맞추기 (초록 영역 30~60도, 바늘은 1초에 90~200도: 보고 멈출 수 있는 속도)
                const span1 = Math.floor(Math.random() * 31) + 30;
                const span2 = Math.floor(Math.random() * 31) + 30;
                const startAngle1 = Math.random() * 300;
                const startAngle2 = Math.random() * 300;

                const getExtremeSpeed = () => {
                    const spd = Math.random() * 110 + 90;
                    return spd * (Math.random() < 0.5 ? 1 : -1);
                };

                return {
                    dials: [
                        { angle: Math.random()*360, speed: getExtremeSpeed(), greenStart: startAngle1, greenSpan: span1, stopped: false, success: false },
                        { angle: Math.random()*360, speed: getExtremeSpeed(), greenStart: startAngle2, greenSpan: span2, stopped: false, success: false }
                    ],
                    isRunning: true
                };
            case 3: // 숫자 합 맞추기 (버튼 6개, 합 100이 되는 두 가지 그룹 포함)
                let group1 = [
                    Math.floor(Math.random() * 20) + 10,
                    Math.floor(Math.random() * 20) + 15,
                    0
                ];
                group1[2] = 100 - (group1[0] + group1[1]);
                while (group1[2] < 10 || group1[2] > 60 || group1.includes(group1[2]) && group1.indexOf(group1[2]) !== 2) {
                    group1[0] = Math.floor(Math.random() * 20) + 10;
                    group1[1] = Math.floor(Math.random() * 20) + 15;
                    group1[2] = 100 - (group1[0] + group1[1]);
                }

                let group2 = [
                    Math.floor(Math.random() * 20) + 12,
                    Math.floor(Math.random() * 20) + 18,
                    0
                ];
                group2[2] = 100 - (group2[0] + group2[1]);
                while (group2[2] < 10 || group2[2] > 60 || group1.includes(group2[0]) || group1.includes(group2[1]) || group1.includes(group2[2])) {
                    group2[0] = Math.floor(Math.random() * 20) + 12;
                    group2[1] = Math.floor(Math.random() * 20) + 18;
                    group2[2] = 100 - (group2[0] + group2[1]);
                }

                let pool6 = [...group1, ...group2].sort(() => Math.random() - 0.5);
                return {
                    numbers: pool6,
                    selected: []
                };
        }
    },

    later(fn, ms) {
        const id = setTimeout(() => {
            if (this.timers) this.timers.delete(id);
            if (this.alive) fn();
        }, ms);
        if (this.timers) this.timers.add(id);
        return id;
    },

    cancelAllTimers() {
        if (this.timers && typeof this.timers.forEach === 'function') {
            this.timers.forEach(clearTimeout);
            this.timers.clear();
        }
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    },

    startGlobalTimer() {
        if (this.gameStarted) return;
        this.gameStarted = true;

        const interval = setInterval(() => {
            if (!this.alive) { clearInterval(interval); return; }
            this.timeLeft--;

            const timerEls = this.root?.querySelectorAll('#bombTimer');
            timerEls?.forEach(timerEl => {
                timerEl.textContent = this.clock();
                if (this.timeLeft <= 10) timerEl.classList.add('text-red-500', 'animate-pulse');
            });

            if (this.timeLeft <= 0) {
                clearInterval(interval);
                sound.playDeepBoom();
                this.framework.gameOver('시한폭탄이 폭발했습니다.', '제4관문 제한 시간 초과');
            }
        }, 1000);
        if (this.timers) this.timers.add(interval);
    },

    render() {
        if (!this.root) this.root = this.framework.container;
        if (this.currentView === 'bomb') {
            this.renderBombView();
        } else {
            this.renderPuzzleView(this.currentView);
        }
    },

    renderBombView() {
        const p1 = this.puzzles[0];
        const p2 = this.puzzles[1];
        const getTitle = t => ['전선 자르기', '방향 맞추기', '타이밍 맞추기', '숫자 합 맞추기'][t];

        this.root.innerHTML = `
            <section class="memory-panel relative overflow-hidden" aria-label="제4관문 시한폭탄 해체" style="background: linear-gradient(135deg, #181111 0%, #0a0606 50%, #020101 100%);">
              <div class="absolute top-2 left-2 w-2 h-2 rounded-full bg-zinc-600 border border-zinc-900 shadow-inner"></div>
              <div class="absolute top-2 right-2 w-2 h-2 rounded-full bg-zinc-600 border border-zinc-900 shadow-inner"></div>
              <div class="absolute bottom-2 left-2 w-2 h-2 rounded-full bg-zinc-600 border border-zinc-900 shadow-inner"></div>
              <div class="absolute bottom-2 right-2 w-2 h-2 rounded-full bg-zinc-600 border border-zinc-900 shadow-inner"></div>

              <div class="memory-eyebrow text-zinc-400 tracking-widest font-mono">THE FINAL SEAT / STAGE 04</div>
              <h2 class="text-2xl font-black text-zinc-100 tracking-wider mb-1">시한폭탄 해체</h2>
              <p class="memory-intro text-zinc-400 mb-3">철제 케이스가 장착된 뇌관입니다. 작전 개시 후 두 개의 회로 모듈을 해체하십시오.</p>

              <div class="flex flex-col sm:flex-row items-center justify-between w-full max-w-xl bg-black/80 border border-zinc-800 p-3.5 rounded-lg my-2 shadow-[0_0_15px_rgba(0,0,0,0.8)]">
                  <div class="flex items-center gap-3">
                      <span class="text-[10px] font-mono text-zinc-500 tracking-widest">TIME_REMAINING</span>
                      <div id="bombTimer" class="font-mono text-2xl font-extrabold text-red-500 bg-zinc-950 px-3 py-1 rounded border border-red-900/60 shadow-[inset_0_0_8px_rgba(239,68,68,0.4)] tracking-widest">
                          ${this.clock()}
                      </div>
                  </div>
                  ${!this.gameStarted ? '<button id="btnBombStart" class="px-5 py-2.5 bg-gradient-to-r from-red-800 to-red-600 hover:from-red-700 hover:to-red-500 text-white text-xs font-black tracking-widest rounded shadow-lg transition animate-pulse border border-red-500">작전 개시 (ARM)</button>' : '<div class="flex items-center gap-2 px-3 py-1 bg-red-950/40 border border-red-900/50 rounded"><span class="w-2 h-2 rounded-full bg-red-500 animate-ping"></span><span class="text-xs font-mono text-red-400 font-bold">ARMED & ACTIVE</span></div>'}
              </div>

              <div class="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-2xl my-3 p-4 bg-zinc-950/90 border border-zinc-800 rounded-xl shadow-inner">
                <div class="bg-gradient-to-b from-zinc-900 to-zinc-950 border ${p1.solved ? 'border-emerald-700/60 bg-emerald-950/20' : 'border-zinc-700'} rounded-lg p-5 flex flex-col items-center justify-between transition shadow-md relative overflow-hidden">
                    ${p1.solved ? '<div class="absolute top-0 right-0 bg-emerald-900/60 text-emerald-300 text-[9px] font-mono px-2 py-0.5 rounded-bl">SECURE</div>' : '<div class="absolute top-0 right-0 bg-red-950/60 text-red-400 text-[9px] font-mono px-2 py-0.5 rounded-bl animate-pulse">DANGER</div>'}
                    <span class="text-[11px] font-mono text-zinc-400 tracking-widest mb-1">CIRCUIT-A</span>
                    <h3 class="font-bold text-lg text-zinc-100 mb-2">${getTitle(p1.type)}</h3>
                    <div class="w-16 h-2.5 bg-zinc-950 border border-zinc-800 rounded-full my-2 flex justify-center items-center">
                        <div class="w-3 h-3 rounded-full ${p1.solved ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : this.gameStarted ? 'bg-red-500 shadow-[0_0_8px_#ef4444] animate-ping' : 'bg-zinc-700'}"></div>
                    </div>
                    <p class="text-xs mb-3 font-semibold ${p1.solved ? 'text-emerald-400' : 'text-amber-500'}">${p1.solved ? '✔ 해제 완료' : this.gameStarted ? '⚠ 활성화됨' : '🔒 대기 중'}</p>
                    <button class="btn-death w-full py-2.5 rounded text-xs tracking-wider ${p1.solved || !this.gameStarted ? 'opacity-40 cursor-not-allowed' : ''}" data-open="0" ${p1.solved || !this.gameStarted ? 'disabled' : ''}>모듈 접속 (OPEN)</button>
                </div>

                <div class="bg-gradient-to-b from-zinc-900 to-zinc-950 border ${p2.solved ? 'border-emerald-700/60 bg-emerald-950/20' : 'border-zinc-700'} rounded-lg p-5 flex flex-col items-center justify-between transition shadow-md relative overflow-hidden">
                    ${p2.solved ? '<div class="absolute top-0 right-0 bg-emerald-900/60 text-emerald-300 text-[9px] font-mono px-2 py-0.5 rounded-bl">SECURE</div>' : '<div class="absolute top-0 right-0 bg-red-950/60 text-red-400 text-[9px] font-mono px-2 py-0.5 rounded-bl animate-pulse">DANGER</div>'}
                    <span class="text-[11px] font-mono text-zinc-400 tracking-widest mb-1">CIRCUIT-B</span>
                    <h3 class="font-bold text-lg text-zinc-100 mb-2">${getTitle(p2.type)}</h3>
                    <div class="w-16 h-2.5 bg-zinc-950 border border-zinc-800 rounded-full my-2 flex justify-center items-center">
                        <div class="w-3 h-3 rounded-full ${p2.solved ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : this.gameStarted ? 'bg-red-500 shadow-[0_0_8px_#ef4444] animate-ping' : 'bg-zinc-700'}"></div>
                    </div>
                    <p class="text-xs mb-3 font-semibold ${p2.solved ? 'text-emerald-400' : 'text-amber-500'}">${p2.solved ? '✔ 해제 완료' : this.gameStarted ? '⚠ 활성화됨' : '🔒 대기 중'}</p>
                    <button class="btn-death w-full py-2.5 rounded text-xs tracking-wider ${p2.solved || !this.gameStarted ? 'opacity-40 cursor-not-allowed' : ''}" data-open="1" ${p2.solved || !this.gameStarted ? 'disabled' : ''}>모듈 접속 (OPEN)</button>
                </div>
              </div>

              <p id="bombStatus" class="text-xs font-mono text-zinc-400 bg-black/40 px-3 py-1.5 rounded border border-zinc-900" role="status" aria-live="polite">
                  ${this.gameStarted ? '>> [SYSTEM]: 회로 모듈을 선택하여 해제를 진행하세요.' : '>> [STATUS]: 상단의 [작전 개시] 버튼을 눌러 폭탄 기폭 시스템을 활성화하세요.'}
              </p>
            </section>
        `;

        const startBtn = this.root.querySelector('#btnBombStart');
        if (startBtn) {
            startBtn.onclick = () => {
                sound.playClick();
                this.startGlobalTimer();
                this.render();
            };
        }

        this.root.querySelectorAll('[data-open]').forEach(btn => {
            btn.onclick = (e) => {
                if(btn.disabled || !this.gameStarted) return;
                sound.playClick();
                this.currentView = parseInt(e.currentTarget.getAttribute('data-open'));
                this.isInputLocked = false;
                this.render();
            };
        });
    },

    renderPuzzleView(index) {
        const puzzle = this.puzzles[index];
        const titles = ['전선 자르기', '방향 맞추기', '타이밍 맞추기', '숫자 합 맞추기'];
        const rules = [
            '규칙: 6개의 전선 중 올바른 전선 2개를 찾으십시오. 첫 번째 선택은 무조건 안전합니다. 올바른 전선을 자르면 양옆 전선의 힌트가 즉시 표시됩니다.',
            '규칙: 메모지에 무작위로 뒤섞여 나타난 10가지 순서대로 십자 패드의 버튼을 입력하십시오.',
            '규칙: 두 개의 회전 바늘을 멈추어 초록색 영역 안에 정확히 안착시키십시오.',
            '규칙: 6개의 숫자 중 합이 정확히 100이 되는 3개의 숫자를 선택하십시오.'
        ];

        this.root.innerHTML = `
            <section class="memory-panel" aria-label="퍼즐 해제 화면">
              <div class="flex justify-between items-center w-full mb-2">
                <button id="btnBackToBomb" class="px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-xs hover:bg-zinc-800 transition">← 폭탄 본체로</button>
              </div>
              <div class="memory-eyebrow">MODULE 0${index+1} / ${titles[puzzle.type]}</div>
              <h2 class="text-xl md:text-2xl font-bold my-1">${titles[puzzle.type]}</h2>

              <!-- 퍼즐 상단 중앙 타이머 영역 -->
              <div class="flex items-center justify-center gap-2.5 my-2.5 px-6 py-1.5 bg-black/90 border border-red-950 rounded-lg shadow-[0_0_12px_rgba(0,0,0,0.6)]">
                  <span class="text-[10px] font-mono text-zinc-400 tracking-widest">REMAINING TIME :</span>
                  <div id="bombTimer" class="font-mono text-xl font-extrabold text-red-500 tracking-wider">
                      ${this.clock()}
                  </div>
              </div>

              <p class="text-xs text-zinc-400 bg-zinc-900/80 border border-zinc-800 p-2.5 rounded my-2 text-left leading-relaxed">${rules[puzzle.type]}</p>

              <div id="puzzleArea" class="w-full my-3 flex flex-col items-center justify-center min-h-[180px]"></div>

              <p id="puzzleStatus" class="text-xs text-amber-400 h-6" role="status" aria-live="polite">퍼즐을 진행하세요.</p>
            </section>
        `;

        this.root.querySelector('#btnBackToBomb').onclick = () => {
            sound.playClick();
            if(this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
            this.currentView = 'bomb';
            this.render();
        };

        this.buildPuzzleUI(index);
    },

    buildPuzzleUI(index) {
        const puzzle = this.puzzles[index];
        const area = this.root.querySelector('#puzzleArea');
        if (!area) return;

        switch(puzzle.type) {
            case 0:
                area.innerHTML = `
                    <div class="grid grid-cols-6 gap-2 w-full max-w-lg my-2">
                        ${puzzle.data.wires.map((w, i) => `
                            <div class="flex flex-col items-center bg-zinc-900 border border-zinc-800 p-2 rounded">
                                <div class="w-3 h-3 rounded-full mb-3 transition-colors ${
                                    w.light === 'green' ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' :
                                    w.light === 'red' ? 'bg-rose-600 shadow-[0_0_8px_#e11d48]' :
                                    w.light === 'gray' ? 'bg-zinc-500' : 'bg-zinc-700'
                                }"></div>
                                <div class="w-2 h-20 bg-zinc-700 rounded my-1 relative cursor-pointer group" data-wire="${i}">
                                    <div class="absolute inset-0 bg-red-800 rounded opacity-70 group-hover:opacity-100 transition ${w.cut ? 'hidden' : ''}"></div>
                                    <div class="absolute inset-0 bg-zinc-950 border border-zinc-700 rounded flex flex-col justify-between py-1 items-center ${w.cut ? 'flex' : 'hidden'}">
                                        <div class="w-3 h-1 bg-zinc-600 rounded"></div>
                                        <div class="w-3 h-1 bg-zinc-600 rounded"></div>
                                    </div>
                                </div>
                                <span class="text-[10px] font-mono text-zinc-400 mt-2">W-${i+1}</span>
                            </div>
                        `).join('')}
                    </div>
                `;
                area.querySelectorAll('[data-wire]').forEach(el => {
                    el.onclick = (e) => {
                        if (this.isInputLocked) return;
                        const i = parseInt(e.currentTarget.getAttribute('data-wire'));
                        this.cutWire(index, i);
                    };
                });
                break;

            case 1:
                area.innerHTML = `
                    <div class="bg-zinc-900 border border-zinc-800 p-3 rounded-lg w-full max-w-md mb-3 text-center">
                        <span class="text-[10px] font-mono text-zinc-500 block mb-1">메모지 순서 힌트 (10개 혼합)</span>
                        <div class="flex justify-center gap-1.5 font-mono text-base font-bold text-zinc-200 flex-wrap">
                            ${puzzle.data.sequence.map((d, i) => `
                                <span class="${i < puzzle.data.currentIndex ? 'text-zinc-600 line-through' : i === puzzle.data.currentIndex ? 'text-amber-400 scale-110 underline' : 'text-zinc-300'}">${d}</span>
                            `).join('')}
                        </div>
                    </div>
                    <div class="grid grid-cols-3 gap-2 w-48 my-2">
                        <div></div>
                        <button class="btn-death py-3 rounded text-xl font-bold text-zinc-200" data-dir="up">↑</button>
                        <div></div>
                        <button class="btn-death py-3 rounded text-xl font-bold text-zinc-200" data-dir="left">←</button>
                        <div class="flex items-center justify-center text-[10px] font-mono text-zinc-600">PAD</div>
                        <button class="btn-death py-3 rounded text-xl font-bold text-zinc-200" data-dir="right">→</button>
                        <div></div>
                        <button class="btn-death py-3 rounded text-xl font-bold text-zinc-200" data-dir="down">↓</button>
                        <div></div>
                    </div>
                `;
                area.querySelectorAll('[data-dir]').forEach(btn => {
                    btn.onclick = (e) => {
                        if (this.isInputLocked) return;
                        const d = e.currentTarget.getAttribute('data-dir');
                        this.inputDirection(index, d);
                    };
                });
                break;

            case 2:
                area.innerHTML = `
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-6 w-full max-w-lg my-2">
                        ${puzzle.data.dials.map((d, i) => {
                            const circumference = 251.2;
                            const dashArray = (d.greenSpan / 360) * circumference;
                            const dashOffset = - (d.greenStart / 360) * circumference;
                            return `
                            <div class="flex flex-col items-center bg-zinc-900 border border-zinc-800 p-4 rounded-lg">
                                <span class="text-xs font-mono text-zinc-400 mb-2">DIAL 0${i+1}</span>
                                <div class="relative w-28 h-28 rounded-full border-4 border-zinc-700 flex items-center justify-center bg-black/40 overflow-hidden">
                                    <svg class="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100">
                                        <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(16, 185, 129, 0.75)" stroke-width="16" stroke-dasharray="${dashArray} ${circumference}" stroke-dashoffset="${dashOffset}" transform="rotate(-90 50 50)" />
                                    </svg>
                                    <div class="absolute w-1.5 h-12 bg-red-500 rounded-t top-1/2 left-1/2" id="dialNeedle${i}" style="transform: translate(-50\%, -100\%) rotate(${d.angle}deg); transform-origin: bottom center;"></div>
                                    <div class="w-3.5 h-3.5 bg-zinc-300 rounded-full z-10 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 shadow"></div>
                                </div>
                                <button class="btn-death mt-4 px-4 py-2 rounded text-xs w-full" data-stop="${i}" ${d.stopped ? 'disabled' : ''}>${d.stopped ? '정지됨' : 'STOP'}</button>
                            </div>
                            `;
                        }).join('')}
                    </div>
                `;
                area.querySelectorAll('[data-stop]').forEach(btn => {
                    btn.onclick = (e) => {
                        if (this.isInputLocked) return;
                        const i = parseInt(e.currentTarget.getAttribute('data-stop'));
                        this.stopDial(index, i);
                    };
                });
                this.startTimingLoop(index);
                break;

            case 3:
                area.innerHTML = `
                    <div class="text-xs font-mono text-zinc-400 mb-2">선택된 수: <span class="text-amber-400 font-bold">${puzzle.data.selected.map(idx => puzzle.data.numbers[idx]).join(' + ') || '없음'}</span></div>
                    <div class="grid grid-cols-3 gap-3 w-full max-w-xs my-2">
                        ${puzzle.data.numbers.map((n, i) => {
                            const isSelected = puzzle.data.selected.includes(i);
                            return `
                                <button class="btn-death py-3 rounded text-base font-bold ${isSelected ? 'border-amber-500 text-amber-400 bg-amber-950/30' : 'text-zinc-200'}" data-num="${i}">${n}</button>
                            `;
                        }).join('')}
                    </div>
                `;
                area.querySelectorAll('[data-num]').forEach(btn => {
                    btn.onclick = (e) => {
                        if (this.isInputLocked) return;
                        const i = parseInt(e.currentTarget.getAttribute('data-num'));
                        this.selectNumber(index, i);
                    };
                });
                break;
        }
    },

    cutWire(pIndex, wireIndex) {
        const puzzle = this.puzzles[pIndex];
        const wire = puzzle.data.wires[wireIndex];
        if (wire.cut || this.isInputLocked) return;

        const cutCount = puzzle.data.wires.filter(w => w.cut).length;
        if (cutCount === 0 && wire.type === 'forbidden') {
            const safeIdx = puzzle.data.wires.findIndex(w => w.type !== 'forbidden' && !w.cut);
            if (safeIdx !== -1) {
                let temp = puzzle.data.wires[wireIndex].type;
                puzzle.data.wires[wireIndex].type = puzzle.data.wires[safeIdx].type;
                puzzle.data.wires[safeIdx].type = temp;
            }
        }

        wire.cut = true;
        sound.playClick();

        if (wire.type === 'forbidden') {
            wire.light = 'red';
            sound.playDeepBoom();
            this.buildPuzzleUI(pIndex);
            this.failPuzzle(pIndex, '잘못된 전선을 잘랐습니다! 회로가 리셋됩니다.');
        } else if (wire.type === 'neutral') {
            wire.light = 'gray';
            this.root.querySelector('#puzzleStatus').textContent = '아무 반응이 없는 중립 전선입니다.';
            this.buildPuzzleUI(pIndex);
        } else if (wire.type === 'target') {
            wire.light = 'green';
            puzzle.data.targetsLeft--;

            if (wireIndex > 0) {
                const leftW = puzzle.data.wires[wireIndex-1];
                leftW.light = leftW.type === 'forbidden' ? 'red' : leftW.type === 'target' ? 'green' : 'gray';
            }
            if (wireIndex < 5) {
                const rightW = puzzle.data.wires[wireIndex+1];
                rightW.light = rightW.type === 'forbidden' ? 'red' : rightW.type === 'target' ? 'green' : 'gray';
            }

            this.buildPuzzleUI(pIndex);
            if (puzzle.data.targetsLeft <= 0) {
                this.solvePuzzle(pIndex);
            } else {
                this.root.querySelector('#puzzleStatus').textContent = '올바른 전선입니다! 양옆 전선의 상태가 드러났습니다.';
            }
        }
    },

    inputDirection(pIndex, dir) {
        if (this.isInputLocked) return;
        const puzzle = this.puzzles[pIndex];
        const hint = puzzle.data.sequence[puzzle.data.currentIndex];

        const upSet = ['↑', 'W', '북'];
        const downSet = ['↓', 'S', '남'];
        const leftSet = ['←', 'A', '서'];
        const rightSet = ['→', 'D', '동'];

        let isMatch = false;
        if (dir === 'up' && upSet.includes(hint)) isMatch = true;
        if (dir === 'down' && downSet.includes(hint)) isMatch = true;
        if (dir === 'left' && leftSet.includes(hint)) isMatch = true;
        if (dir === 'right' && rightSet.includes(hint)) isMatch = true;

        if (isMatch) {
            sound.playClick();
            puzzle.data.currentIndex++;
            this.buildPuzzleUI(pIndex);
            if (puzzle.data.currentIndex >= puzzle.data.sequence.length) {
                this.solvePuzzle(pIndex);
            }
        } else {
            sound.playDeepBoom();
            this.buildPuzzleUI(pIndex);
            this.failPuzzle(pIndex, '방향 순서가 틀렸습니다! 시퀀스가 리셋됩니다.');
        }
    },

    startTimingLoop(pIndex) {
        if (this.rafId) cancelAnimationFrame(this.rafId);
        const puzzle = this.puzzles[pIndex];
        let lastTime = performance.now();

        const loop = (now) => {
            if (!this.alive || this.currentView !== pIndex) return;
            const dt = (now - lastTime) / 1000;
            lastTime = now;

            puzzle.data.dials.forEach((d, i) => {
                if (!d.stopped) {
                    d.angle = (d.angle + d.speed * dt) % 360;
                    if (d.angle < 0) d.angle += 360;
                    const needle = this.root?.querySelector(`#dialNeedle${i}`);
                    if (needle) {
                        needle.style.transform = `translate(-50%, -100%) rotate(${d.angle}deg)`;
                    }
                }
            });

            this.rafId = requestAnimationFrame(loop);
        };
        this.rafId = requestAnimationFrame(loop);
    },

    stopDial(pIndex, dialIndex) {
        if (this.isInputLocked) return;
        const puzzle = this.puzzles[pIndex];
        const dial = puzzle.data.dials[dialIndex];
        dial.stopped = true;
        sound.playClick();

        const normalizedAngle = (dial.angle % 360 + 360) % 360;
        const greenEnd = (dial.greenStart + dial.greenSpan) % 360;
        if (greenEnd > dial.greenStart) {
            dial.success = (normalizedAngle >= dial.greenStart && normalizedAngle <= greenEnd);
        } else {
            dial.success = (normalizedAngle >= dial.greenStart || normalizedAngle <= greenEnd);
        }

        if (puzzle.data.dials.every(d => d.stopped)) {
            if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
            this.buildPuzzleUI(pIndex);
            if (puzzle.data.dials.every(d => d.success)) {
                this.solvePuzzle(pIndex);
            } else {
                sound.playDeepBoom();
                this.failPuzzle(pIndex, '바늘이 초록 영역을 벗어났습니다! 타이밍 리셋.');
            }
        } else {
            this.buildPuzzleUI(pIndex);
        }
    },

    selectNumber(pIndex, numIndex) {
        if (this.isInputLocked) return;
        const puzzle = this.puzzles[pIndex];
        if (puzzle.data.selected.includes(numIndex)) return;

        puzzle.data.selected.push(numIndex);
        sound.playClick();
        this.buildPuzzleUI(pIndex);

        if (puzzle.data.selected.length === 3) {
            const sum = puzzle.data.selected.reduce((acc, idx) => acc + puzzle.data.numbers[idx], 0);
            if (sum === 100) {
                this.solvePuzzle(pIndex);
            } else {
                sound.playDeepBoom();
                this.failPuzzle(pIndex, `선택한 수의 합이 ${sum}입니다 (100 아님). 리셋됩니다.`);
            }
        }
    },

    failPuzzle(pIndex, message) {
        if(this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        this.isInputLocked = true;
        const statusEl = this.root?.querySelector('#puzzleStatus');
        if(statusEl) statusEl.textContent = message;

        this.later(() => {
            if(!this.alive) return;
            this.puzzles[pIndex].data = this.createPuzzleData(this.puzzles[pIndex].type);
            this.isInputLocked = false;
            this.renderPuzzleView(pIndex);
        }, 1400);
    },

    solvePuzzle(pIndex) {
        if(this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        const puzzle = this.puzzles[pIndex];
        puzzle.solved = true;
        sound.playClick();

        const statusEl = this.root?.querySelector('#puzzleStatus');
        if(statusEl) statusEl.textContent = '모듈 해제 성공!';

        this.later(() => {
            if(!this.alive) return;
            if (this.puzzles.every(p => p.solved)) {
                this.cancelAllTimers();
                this.framework.nextStage();
            } else {
                this.currentView = 'bomb';
                this.render();
            }
        }, 1200);
    },

    destroy() {
        this.alive = false;
        this.cancelAllTimers();
    }
};

GameFramework.registerStage('stage_4', BombDefusalStage4);


// STAGE 05 · 1v1 Russian Roulette Module
const RussianRouletteStage5 = {
    name: '제5관문: 1대1 러시안 룰렛',
    init(container, framework) {
        this.destroy();
        this.alive = true;
        this.framework = framework;

        // 6개의 챔버 중 1개에 실탄 저장
        this.bulletChamber = Math.floor(Math.random() * 6);
        this.currentChamber = 0;
        this.isBusy = false;

        // 팝업 애니메이션 스타일 추가
        this.injectCustomStyles();

        container.innerHTML = `
        <section class="memory-panel poison-panel relative">
            <div class="memory-eyebrow">THE FINAL SEAT / STAGE 05</div>
            <h2 class="text-3xl font-black text-red-700 font-cinzel my-2">1대1 러시안 룰렛</h2>
            <p class="memory-intro">6발의 실린더, 단 한 발의 실탄. 운명을 건 마지막 주사위.</p>

            <div class="roulette-container">
                <div class="roulette-status-card">
                    <div class="text-xs text-zinc-400 mb-1">리볼버 실린더 상태 (6개 챔버)</div>
                    <div class="cylinder-display" id="cylinderDisplay">
                        ${Array.from({length: 6}, (_, i) => `<div class="chamber-dot" id="chamber-${i}"></div>`).join('')}
                    </div>
                </div>

                <div class="dice-box">
                    <div class="dice-card">
                        <span class="text-xs text-zinc-400 font-mono mb-2">PLAYER</span>
                        <div class="dice-value" id="playerDice">?</div>
                    </div>
                    <div class="text-xl font-bold text-zinc-600 font-mono">VS</div>
                    <div class="dice-card">
                        <span class="text-xs text-zinc-400 font-mono mb-2">OPPONENT</span>
                        <div class="dice-value" id="opponentDice">?</div>
                    </div>
                </div>

                <p id="rouletteStatus" class="text-sm text-zinc-300 min-h-[48px] my-3 leading-relaxed">
                    내 주사위는 1→6 순서로 돌아갑니다. 원하는 숫자에서 멈추세요 (스페이스).<br>숫자가 더 낮은 사람이 자신에게 방아쇠를 당기고, 비기면 다시 굴립니다.
                </p>

                <div class="memory-actions w-full">
                    <button id="btnRollDice" class="btn-death w-full py-3.5 rounded text-red-500 font-bold text-sm tracking-wider">
                        주사위 굴리기 (ROLL DICE)
                    </button>
                </div>
            </div>

            <!-- 격발 전용 팝업 모달 레이어 -->
            <div id="triggerModal" class="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center hidden opacity-0 transition-opacity duration-300">
                <div id="triggerCard" class="bg-zinc-950 border-2 border-red-950 text-zinc-200 w-11/12 max-w-md rounded-2xl p-6 sm:p-8 shadow-[0_0_50px_rgba(153,27,27,0.4)] flex flex-col items-center relative overflow-hidden">
                    <div class="text-xs font-mono tracking-widest text-red-600 mb-1" id="modalTargetRole">PULL THE TRIGGER</div>
                    <h3 class="text-2xl font-black font-cinzel text-zinc-100 mb-4" id="modalTitle">격발 준비</h3>

                    <!-- 연출 그래픽 영역: 왼쪽 사람 실루엣 + 오른쪽 base64 리볼버 이미지 (반전 없음) -->
                    <div id="gunGraphicBox" class="w-full h-52 bg-zinc-900/80 rounded-xl border border-zinc-800/80 relative overflow-hidden my-2 flex items-center">
                        <!-- 왼쪽: 사람 실루엣 (고정 비율) -->
                        <div class="absolute left-6 top-1/2 -translate-y-1/2 w-45 h-40 flex items-center justify-center">
                            <svg viewBox="0 0 100 140" class="w-full h-full" id="humanSilhouette">
                                <path d="M 25,10 Q 60,10 60,50 Q 60,85 35,95 L 35,110 Q 60,125 65,140 L 10,140 L 10,10 Z" fill="#ffffff" opacity="0.95" />
                            </svg>
                        </div>
                        <!-- 오른쪽: base64 리볼버 이미지 (원래 방향 유지) -->
                        <div class="absolute left-24 top-1/2 -translate-y-1/2 w-40 h-30 flex items-center justify-center">
                            <img id="revolverImg" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA+gAAAIwCAMAAAAiZ7EgAAAAeFBMVEUAAAD////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////GqOSsAAAAJ3RSTlMAABwoLzhCREtNVVdeYGdxc3Z6fYSNkJeZoKKqrLO1vMbIy8/S2eL/vpd5AAAmu0lEQVR42u3d27bbthGAYVE2EodpN9I6qJ3AqdnYht7/DXuhEyXxBHBA4vDPTVZWVrQpER9ncCBwaAiCGIhDWcENJYgKpHM/CaIC6dxOgqhAOneTICqQzs0kiAqkcy8JogLp3EqCqEA6d5IgKpDOjSSICqRzHwmiAuncRoKoQDp3kSAqkM5NJIgKpHMPCaIC6dxCgqhAOneQICqQzg0kiAqkc/8IogLp3D6CqEA6d49IMo5IBzpRfLStQvpW0FU7E4oGSUQJZaxJso2VCF1pOxNGQ52IktCt685tTCM9NvTWnmbCdVAn4kC/tjHbUr3vDh3qRHXQmyqhn6nTWSfqgd7UCf10cp3FOlEP9KZS6BfrLc2TqAN6Uy300+nkLFmdqAR6UzH0cwUPdaIG6E3F0BmDJ+qB3lQN/TIGTwlPFA+9qRv66eQ6y8AcsTJ0d21PnVFITxH6ZWCOpE6sSegug+4g0OmsEytC6bvzc2Oin54odKgT4encdC6TChHorI0lRNL5Y1I/Ij096MysE0+G2/nQL+n8vh6rbRXSU4ROBU/0lGtj52OYecKzOUCngid6BbkZN7y4KSU50wZ0Knji5ny18tPp1GlG5FKGTgVfvXPTSbSiRKE3QIc60TRqbIDNfx0W8+nJQ6ezLj5AnUlIMU+2k56H9O2g01lfbnzRAHUmIcacN1xygU4Fv2x4WhZHSZEs9AboUN+jO1topDocl4H08Ss/ahvnbvHO+ljNDvNcO+npS59odraLdr86a43mTKfnmh3m+dbuqUsfL9yNi9rsXMeZTiTzkqA3mWZ0vUHLcx3Sm6ZpSeYlQG/y7KOrTeZ4gN40x7ag2bS483BpQ2/y7KNvAt3ofJeCqPvCFuW72qX3/xY1a1439CY/6PNnJhNG34j2n1eL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" class="w-full h-full object-contain" alt="Revolver">
                        </div>
                    </div>

                    <p id="modalDesc" class="text-sm text-zinc-300 text-center my-3 min-h-[36px]">
                        방아쇠를 당길 준비를 하십시오.
                    </p>

                    <!-- 하단 버튼 / 안내 메시지 영역 -->
                    <div class="w-full mt-2" id="modalActionArea">
                        <button id="btnPullTrigger" class="btn-death w-full py-4 rounded-xl text-red-500 font-bold text-base tracking-widest hover:text-white transition">
                            방아쇠 당기기
                        </button>
                        <div id="modalOpponentNotice" class="hidden text-center text-xs font-mono text-amber-500/90 py-3 bg-zinc-900/50 rounded-lg border border-amber-900/30 animate-pulse">
                            상대방이 방아쇠를 당길 준비를 하고 있습니다...
                        </div>
                    </div>
                </div>
            </div>
        </section>`;

        this.status = container.querySelector('#rouletteStatus');
        this.btnRoll = container.querySelector('#btnRollDice');
        this.playerDiceEl = container.querySelector('#playerDice');
        this.oppDiceEl = container.querySelector('#opponentDice');

        // 팝업 관련 엘리먼트 참조
        this.triggerModal = container.querySelector('#triggerModal');
        this.triggerCard = container.querySelector('#triggerCard');
        this.modalTargetRole = container.querySelector('#modalTargetRole');
        this.modalTitle = container.querySelector('#modalTitle');
        this.modalDesc = container.querySelector('#modalDesc');
        this.btnPullTrigger = container.querySelector('#btnPullTrigger');
        this.modalOpponentNotice = container.querySelector('#modalOpponentNotice');
        this.humanSilhouette = container.querySelector('#humanSilhouette');
        this.revolverImg = container.querySelector('#revolverImg');

        this.updateCylinderUI();
        this.btnRoll.onclick = () => this.playTurn();
        this.keyHandler = e => {
            if (e.code !== 'Space' || e.repeat) return;
            e.preventDefault();
            this.playTurn();
        };
        window.addEventListener('keydown', this.keyHandler);
    },

    injectCustomStyles() {
        if (document.getElementById('roulette-custom-style')) return;
        const style = document.createElement('style');
        style.id = 'roulette-custom-style';
        style.innerHTML = `
            @keyframes rouletteBangShake {
                0% { transform: scale(1) translate(0, 0); }
                10% { transform: scale(1.08) translate(-12px, -8px); }
                20% { transform: scale(1.05) translate(14px, 10px); }
                30% { transform: scale(1.06) translate(-10px, 8px); }
                40% { transform: scale(1.02) translate(8px, -6px); }
                50% { transform: scale(1.03) translate(-6px, 4px); }
                100% { transform: scale(1) translate(0, 0); }
            }
            .bang-active {
                animation: rouletteBangShake 0.6s cubic-bezier(.36,.07,.19,.97) both !important;
            }
        `;
        document.head.appendChild(style);
    },

    // 1. 총소리와 동일한 노이즈 메커니즘을 사용한 짧고 단단한 "탁!" 빈 챔버 소리
    playMetallicClick() {
        try {
            sound.init(); const ctx = sound.ctx;
            if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
            const now = ctx.currentTime;

            // 아주 짧은 화이트 노이즈 버퍼 (약 0.04초)
            const bufferSize = ctx.sampleRate * 0.04;
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            const noise = ctx.createBufferSource();
            noise.buffer = buffer;

            // 대역 필터를 거쳐 날카롭고 단단한 기계적 마찰음("탁!") 연출
            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.setValueAtTime(2000, now);
            filter.Q.setValueAtTime(3, now);

            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.4, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

            noise.connect(filter);
            filter.connect(gain);
            gain.connect(ctx.destination);

            noise.start(now);
            noise.stop(now + 0.04);
        } catch(e) {}
    },
    // 2. 묵직하고 강렬한 "탕!" 총소리 (실탄 발사용)
    playGunshot() {
        try {
            sound.init(); const ctx = sound.ctx;
            if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
            const now = ctx.currentTime;

            // 화이트 노이즈 기반 폭발음 생성
            const bufferSize = ctx.sampleRate * 0.4;
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            const noise = ctx.createBufferSource();
            noise.buffer = buffer;

            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(1200, now);
            filter.frequency.exponentialRampToValueAtTime(80, now + 0.35);

            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.35, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

            noise.connect(filter);
            filter.connect(gain);
            gain.connect(ctx.destination);

            noise.start(now);
            noise.stop(now + 0.35);
        } catch(e) {}
    },

    getDiceSvg(val) {
        const dots = {
            1: [[30, 30]],
            2: [[18, 18], [42, 42]],
            3: [[18, 18], [30, 30], [42, 42]],
            4: [[18, 18], [42, 18], [18, 42], [42, 42]],
            5: [[18, 18], [42, 18], [30, 30], [18, 42], [42, 42]],
            6: [[18, 18], [42, 18], [18, 30], [42, 30], [18, 42], [42, 42]]
        };
        const activeDots = dots[val] || dots[1];
        const circles = activeDots.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="5.5" fill="#000000"/>`).join('');
        return `<svg viewBox="0 0 60 60" width="52" height="52" style="display:inline-block;"><rect width="60" height="60" rx="10" fill="#ffffff" stroke="#d1d5db" stroke-width="2"/>${circles}</svg>`;
    },

    updateCylinderUI() {
        for (let i = 0; i < 6; i++) {
            const el = document.getElementById(`chamber-${i}`);
            if (!el) continue;
            if (i < this.currentChamber) {
                el.className = 'chamber-dot spent';
            } else if (i === this.currentChamber) {
                el.className = 'chamber-dot active';
            } else {
                el.className = 'chamber-dot';
            }
        }
    },

    // The player's die turns 1→6 at this pace and stops where the player stops it: a steady hand gets a high
    // number most of the time, so who pulls the trigger is mostly the player's doing (the opponent's die is random).
    dieStepMs: 150,

    playTurn() {
        if (!this.alive || this.isBusy) return;
        if (this.spinTimer) return this.stopDie();
        sound.playClick();
        this.status.textContent = '내 주사위가 돌고 있습니다. 원하는 숫자에서 멈추세요!';
        this.btnRoll.textContent = '멈추기 (STOP · SPACE)';
        this.face = Math.floor(Math.random() * 6) + 1;
        this.playerDiceEl.innerHTML = this.getDiceSvg(this.face);
        this.spinTimer = setInterval(() => {
            this.face = (this.face % 6) + 1;
            this.playerDiceEl.innerHTML = this.getDiceSvg(this.face);
            this.oppDiceEl.innerHTML = this.getDiceSvg(Math.floor(Math.random() * 6) + 1);
        }, this.dieStepMs);
    },

    stopDie() {
        clearInterval(this.spinTimer);
        this.spinTimer = null;
        this.isBusy = true;
        this.btnRoll.disabled = true;
        this.btnRoll.textContent = '주사위 굴리기 (ROLL DICE)';
        this.finalPlayerVal = this.face; // exactly the face on screen when it was stopped
        this.finalOppVal = Math.floor(Math.random() * 6) + 1;
        this.revealDiceSimultaneous();
    },

    revealDiceSimultaneous() {
        sound.playClick();
        this.playerDiceEl.innerHTML = this.getDiceSvg(this.finalPlayerVal);
        this.oppDiceEl.innerHTML = this.getDiceSvg(this.finalOppVal);

        this.status.textContent = `주사위 결과 - 플레이어: [${this.finalPlayerVal}], 상대: [${this.finalOppVal}]. 결과를 판정합니다...`;

        setTimeout(() => {
            if (this.alive) this.resolveTurn(this.finalPlayerVal, this.finalOppVal);
        }, 1000);
    },

    resolveTurn(pVal, oVal) {
        if (pVal === oVal) {
            this.status.textContent = `동점입니다! (플레이어: ${pVal}, 상대: ${oVal}) 다시 주사위를 굴립니다.`;
            this.isBusy = false;
            this.btnRoll.disabled = false;
        } else if (pVal < oVal) {
            this.status.textContent = `플레이어의 숫자가 더 작습니다 (${pVal} vs ${oVal}). 자신에게 방아쇠를 당깁니다...`;
            setTimeout(() => this.openTriggerModal(true), 1200);
        } else {
            this.status.textContent = `상대의 숫자가 더 작습니다 (${pVal} vs ${oVal}). 상대가 자신에게 방아쇠를 당깁니다...`;
            setTimeout(() => this.openTriggerModal(false), 1200);
        }
    },

    // 팝업 열기 연출
    openTriggerModal(isPlayerTarget) {
        if (!this.alive) return;
        this.currentTargetIsPlayer = isPlayerTarget;

        // 실루엣 색상 초기화
        const pathEl = this.humanSilhouette.querySelector('path');
        if (pathEl) pathEl.setAttribute('fill', '#ffffff');
        this.triggerCard.classList.remove('bang-active', 'border-red-600');
        this.triggerCard.classList.add('border-red-950');

        if (isPlayerTarget) {
            this.modalTargetRole.textContent = "YOUR TURN / PLAYER";
            this.modalTitle.textContent = "당신의 운명";
            this.modalDesc.textContent = "주사위에서 패배했습니다. 스스로의 머리에 방아쇠를 당기십시오.";
            this.btnPullTrigger.classList.remove('hidden');
            this.modalOpponentNotice.classList.add('hidden');

            this.btnPullTrigger.onclick = () => {
                this.btnPullTrigger.disabled = true;
                this.pullTrigger(true);
            };
            this.btnPullTrigger.disabled = false;
        } else {
            this.modalTargetRole.textContent = "OPPONENT'S TURN";
            this.modalTitle.textContent = "상대의 운명";
            this.modalDesc.textContent = "상대방의 숫자가 더 낮습니다. 상대의 운명을 지켜보십시오.";
            this.btnPullTrigger.classList.add('hidden');
            this.modalOpponentNotice.classList.remove('hidden');

            // 상대방인 경우 2초 후 자동 격발
            setTimeout(() => {
                if (this.alive) this.pullTrigger(false);
            }, 2200);
        }

        // 팝업 표시
        this.triggerModal.classList.remove('hidden');
        requestAnimationFrame(() => {
            this.triggerModal.classList.remove('opacity-0');
        });
    },

    // 방아쇠 당기기 격발 연출
    pullTrigger(isPlayerTarget) {
        const isHit = (this.currentChamber === this.bulletChamber);
        this.currentChamber++;
        this.updateCylinderUI();

        if (isHit) {
            // [실탄 발사 타격감 연출]
            this.playGunshot();

            this.triggerCard.classList.add('bang-active', 'border-red-600');
            const pathEl = this.humanSilhouette.querySelector('path');
            if (pathEl) pathEl.setAttribute('fill', '#ef4444'); // 피격 시 실루엣 적색 변화

            this.modalDesc.innerHTML = `<strong class="text-red-500 text-lg">BANG!</strong> 탄알이 발사되었습니다!`;

            setTimeout(() => {
                this.triggerModal.classList.add('opacity-0');
                setTimeout(() => this.triggerModal.classList.add('hidden'), 300);

                if (isPlayerTarget) {
                    this.status.textContent = 'BANG! 탄알이 발사되었습니다...';
                    setTimeout(() => {
                        this.framework.gameOver('러시안 룰렛에서 실탄이 발사되었습니다.', '5스테이지 통과 실패');
                    }, 1200);
                } else {
                    this.status.textContent = 'BANG! 상대의 머리에서 탄알이 터졌습니다. 당신이 생존했습니다!';
                    setTimeout(() => {
                        this.framework.nextStage();
                    }, 1800);
                }
            }, 1600);

        } else {
            // [빈 챔버 클릭 연출 (리볼버 흔들림 제거됨)]
            this.playMetallicClick();

            const targetName = isPlayerTarget ? '플레이어' : '상대';
            this.modalDesc.innerHTML = `<span class="text-zinc-400 font-mono text-base">격발... 찰칵!</span><br><span class="text-emerald-400 text-xs">빈 챔버입니다. ${targetName}가 살아남았습니다.</span>`;

            setTimeout(() => {
                this.triggerModal.classList.add('opacity-0');
                setTimeout(() => {
                    this.triggerModal.classList.add('hidden');
                    this.isBusy = false;
                    this.btnRoll.disabled = false;
                    this.status.textContent = `빈 챔버였습니다. ${targetName} 생존! 다음 라운드 주사위를 굴리세요.`;
                }, 300);
            }, 1400);
        }
    },

    closeTriggerModal() {
        if (this.triggerModal) {
            this.triggerModal.classList.add('opacity-0');
            this.triggerModal.classList.add('hidden');
        }
    },

    destroy() {
        this.alive = false;
        clearInterval(this.spinTimer);
        this.spinTimer = null;
        if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
        this.keyHandler = null;
        this.closeTriggerModal();
    }
};
GameFramework.registerStage('stage_5', RussianRouletteStage5);


window.addEventListener('DOMContentLoaded', () => {
    lastTime = performance.now();
    animationFrameId = requestAnimationFrame(animateDust);

    const initAudioOnUserAction = () => {
        sound.startAmbientDrone();
        window.removeEventListener('click', initAudioOnUserAction);
        window.removeEventListener('keydown', initAudioOnUserAction);
    };
    window.addEventListener('click', initAudioOnUserAction);
    window.addEventListener('keydown', initAudioOnUserAction);

    document.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('mouseenter', () => sound.playHover(), { passive: true });
    });

    document.getElementById('btnStart').addEventListener('click', () => {
        sound.playDeepBoom();
        void GameFramework.startRun();
    });

    const btnExit = document.getElementById('btnExit');
    btnExit.classList.toggle('hidden', !IN_CASINO); // a class: the button's own display:flex beats the attribute
    btnExit.addEventListener('click', () => {
        sound.playClick();
        casino.exit();
    });
    document.getElementById('rewardNote').textContent = IN_CASINO
        ? `다섯 관문을 모두 통과하면 ${REWARD}칩 지급 · 실패해도 다시 도전할 수 있습니다`
        : '연습 모드 · 칩은 지급되지 않습니다';

    const modalRules = document.getElementById('modalRules');
    document.getElementById('btnRules').addEventListener('click', () => {
        sound.playClick();
        modalRules.classList.remove('hidden');
        requestAnimationFrame(() => modalRules.classList.remove('opacity-0'));
    });
    document.getElementById('btnCloseRules').addEventListener('click', () => {
        sound.playClick();
        modalRules.classList.add('opacity-0');
        setTimeout(() => modalRules.classList.add('hidden'), 300);
    });

    const modalSettings = document.getElementById('modalSettings');
    document.getElementById('btnSettings').addEventListener('click', () => {
        sound.playClick();
        modalSettings.classList.remove('hidden');
        requestAnimationFrame(() => modalSettings.classList.remove('opacity-0'));
    });
    document.getElementById('btnCloseSettings').addEventListener('click', () => {
        sound.playClick();
        modalSettings.classList.add('opacity-0');
        setTimeout(() => modalSettings.classList.add('hidden'), 300);
    });

    document.getElementById('bgmToggle').addEventListener('change', (e) => {
        sound.isBgmEnabled = e.target.checked;
        if (!sound.isBgmEnabled) sound.stopAmbientDrone();
        else sound.startAmbientDrone();
    });

    document.getElementById('sfxToggle').addEventListener('change', (e) => {
        sound.isSfxEnabled = e.target.checked;
    });

    document.getElementById('flickerToggle').addEventListener('change', (e) => {
        const spotlight = document.querySelector('.spotlight');
        if (e.target.checked) {
            spotlight.style.animation = 'lightSway 12s ease-in-out infinite alternate, lightFlicker 9s infinite';
        } else {
            spotlight.style.animation = 'lightSway 12s ease-in-out infinite alternate';
        }
    });
});

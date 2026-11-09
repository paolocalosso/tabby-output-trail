/*
 * tabby-output-trail — smooth scrolling of terminal output for Tabby.
 *
 * When new output pushes the screen up, the content glides into place
 * instead of jumping a whole row at a time.
 *
 * Plain JavaScript, no build step: Tabby provides @angular/*, tabby-core,
 * tabby-settings and tabby-terminal at runtime and compiles this module JIT.
 *
 * Cost, by design:
 *   - the output stream is never touched: the plugin only observes, so it
 *     can't slow anything down;
 *   - each write only sets a flag; the real work runs once per animation
 *     frame, and only while output is arriving;
 *   - the glide is a CSS transform animated with the Web Animations API,
 *     which the browser runs on the compositor (GPU) with no JavaScript
 *     per frame;
 *   - big jumps and continuous fast output (cat, builds) skip the
 *     animation, as do full-screen apps (vim, htop) and a scrolled-back view.
 *
 * Structure:
 *   SmoothScroller  watches one xterm.js terminal and animates its screen.
 *                   Knows nothing about Tabby.
 *   OutputTrailDecorator attaches a SmoothScroller to every terminal tab.
 *   OutputTrailSettingsComponent is the page in Settings → Output trail.
 */
'use strict'

const { NgModule, Injectable, Component } = require('@angular/core')
const { CommonModule } = require('@angular/common')
const { FormsModule } = require('@angular/forms')
const TabbyCore = require('tabby-core')
const { ConfigProvider, ConfigService } = TabbyCore
const { SettingsTabProvider } = require('tabby-settings')
const { TerminalDecorator } = require('tabby-terminal')

const DEFAULTS = {
    enabled: true,
    // Length of the glide, in ms
    duration: 110,
    // A frame that scrolls more lines than this jumps instead of gliding
    maxLines: 3,
    // Output that keeps scrolling for longer than this (ms) is treated as a
    // stream (cat, build logs): no animation until it pauses
    streamMs: 400,
}

const EASING = 'cubic-bezier(0.22, 0.8, 0.3, 1)'
// A pause this long (ms) ends a stream
const STREAM_GAP_MS = 150

const num = (v, fallback) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
}

/** Merge stored settings over the defaults, with sane types and ranges */
function normalizeSettings (stored) {
    const s = { ...DEFAULTS, ...(stored || {}) }
    return {
        enabled: s.enabled !== false,
        duration: Math.min(1000, Math.max(20, num(s.duration, DEFAULTS.duration))),
        maxLines: Math.min(50, Math.max(1, Math.round(num(s.maxLines, DEFAULTS.maxLines)))),
        streamMs: Math.min(5000, Math.max(0, num(s.streamMs, DEFAULTS.streamMs))),
    }
}

const runOutsideAngular = fn => (typeof Zone !== 'undefined' && Zone.root) ? Zone.root.run(fn) : fn()

const prefersReducedMotion = () => {
    try {
        return !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
        return false
    }
}

class SmoothScroller {
    /**
     * @param xterm        an xterm.js Terminal, already opened
     * @param getSettings  () => normalized settings
     */
    constructor (xterm, getSettings) {
        this.xterm = xterm
        this.getSettings = getSettings
        this.disposables = []
        this.raf = 0
        this.dirty = false
        this.anim = null
        this.marker = null
        this.markerLine = 0
        this.lastBase = this.buffer.baseY
        this.streamStart = 0
        this.lastScrollTime = 0
        this.stats = { animated: 0, skipped: 0 }

        this.trackMarker()
        const onWrite = this.xterm.onWriteParsed || this.xterm.onRender
        if (typeof onWrite === 'function') {
            this.disposables.push(onWrite.call(this.xterm, () => this.schedule()))
        }
        if (typeof this.xterm.onResize === 'function') {
            this.disposables.push(this.xterm.onResize(() => this.resync()))
        }
    }

    get buffer () {
        return this.xterm.buffer.active
    }

    get screen () {
        return this.xterm.element?.querySelector('.xterm-screen') || null
    }

    /**
     * A marker on the cursor line: when the scrollback is full, xterm drops
     * the oldest lines and baseY stops growing, but the marker's line goes
     * down by the number of dropped lines, so baseY growth + marker drop is
     * always the number of lines that scrolled.
     */
    trackMarker () {
        this.marker?.dispose()
        this.marker = null
        if (typeof this.xterm.registerMarker !== 'function' || this.buffer.type !== 'normal') return
        try {
            this.marker = this.xterm.registerMarker(0)
        } catch {
            this.marker = null
        }
        this.markerLine = this.marker ? this.marker.line : 0
    }

    /** Forget the reference point, e.g. after a resize or screen switch */
    resync () {
        this.cancel()
        this.lastBase = this.buffer.baseY
        this.trackMarker()
    }

    schedule () {
        this.dirty = true
        if (this.raf) return
        runOutsideAngular(() => {
            this.raf = requestAnimationFrame(t => this.frame(t))
        })
    }

    /** Lines the screen scrolled since the last frame (0 if none or unknown) */
    scrolledLines () {
        const base = this.buffer.baseY
        let lines = base - this.lastBase
        this.lastBase = base

        if (this.marker && !this.marker.isDisposed && this.marker.line >= 0) {
            lines += this.markerLine - this.marker.line
            this.markerLine = this.marker.line
        } else {
            // The marker scrolled out of the scrollback: start a new one
            this.trackMarker()
        }
        return lines
    }

    frame (now) {
        this.raf = 0
        if (!this.dirty) return
        this.dirty = false

        if (this.buffer.type !== 'normal') {
            // vim, htop, less...: no glide, and resync when we come back
            this.cancel()
            this.lastBase = this.buffer.baseY
            this.marker?.dispose()
            this.marker = null
            return
        }
        if (!this.marker) this.trackMarker()

        const lines = this.scrolledLines()
        if (lines <= 0) return

        const s = this.getSettings()
        // Is this part of a continuous stream of output?
        if (now - this.lastScrollTime > STREAM_GAP_MS) this.streamStart = now
        this.lastScrollTime = now
        const streaming = s.streamMs > 0 && now - this.streamStart > s.streamMs

        const following = this.buffer.viewportY === this.buffer.baseY
        if (!s.enabled || !following || streaming || prefersReducedMotion()) {
            this.skip()
            return
        }
        this.glide(lines, s)
    }

    cellHeight () {
        const h = this.xterm._core?._renderService?.dimensions?.css?.cell?.height
        if (h) return h
        const screen = this.screen
        return screen && this.xterm.rows ? screen.clientHeight / this.xterm.rows : 0
    }

    /** Current vertical offset of the screen while a glide is running */
    currentOffset () {
        if (!this.anim || this.anim.playState !== 'running' || !this.screen) return 0
        try {
            const t = getComputedStyle(this.screen).transform
            if (!t || t === 'none') return 0
            const m = t.match(/matrix(3d)?\(([^)]+)\)/)
            if (!m) return 0
            const v = m[2].split(',').map(Number)
            return m[1] ? v[13] : v[5]
        } catch {
            return 0
        }
    }

    glide (lines, s) {
        const screen = this.screen
        const cell = this.cellHeight()
        if (!screen || !cell || typeof screen.animate !== 'function') return

        const from = this.currentOffset() + lines * cell
        if (from > s.maxLines * cell) {
            // Too far to glide (big output chunk, clear...): just jump
            this.skip()
            return
        }
        this.anim?.cancel()
        this.anim = screen.animate(
            [{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }],
            { duration: s.duration, easing: EASING },
        )
        this.stats.animated++
    }

    skip () {
        this.cancel()
        this.stats.skipped++
    }

    cancel () {
        if (this.anim) {
            this.anim.cancel()
            this.anim = null
        }
    }

    dispose () {
        if (this.raf) cancelAnimationFrame(this.raf)
        this.raf = 0
        this.cancel()
        this.marker?.dispose()
        this.marker = null
        for (const d of this.disposables) {
            try { d.dispose() } catch { }
        }
        this.disposables = []
    }
}

class OutputTrailDecorator extends TerminalDecorator {
    constructor () {
        super()
        this.scrollers = new Map()
    }

    attach (tab) {
        if (!tab.frontend || !tab.frontend.xterm) {
            return // not an xterm frontend
        }
        try {
            const scroller = new SmoothScroller(
                tab.frontend.xterm,
                () => normalizeSettings(tab.config?.store?.outputTrail),
            )
            this.scrollers.set(tab, scroller)
        } catch (e) {
            console.warn('[tabby-output-trail] attach failed', e)
        }
    }

    detach (tab) {
        this.scrollers.get(tab)?.dispose()
        this.scrollers.delete(tab)
        super.detach(tab)
    }
}
Injectable()(OutputTrailDecorator)

class OutputTrailConfigProvider extends ConfigProvider {
    constructor () {
        super()
        this.defaults = { outputTrail: { ...DEFAULTS } }
        this.platformDefaults = {}
    }
}
Injectable()(OutputTrailConfigProvider)

/* ---------------------------------------------------------------- Settings */

const PREVIEW_ROWS = 7

const SETTINGS_TEMPLATE = `
<h3>Output trail</h3>
<p class="ot-intro">New output glides into place instead of jumping a row at a time.</p>

<div class="form-line">
    <div class="header">
        <div class="title">Enable</div>
    </div>
    <toggle [(ngModel)]="s.enabled" (ngModelChange)="save()"></toggle>
</div>

<div class="ot-preview" [class.ot-off]="!s.enabled">
    <div class="ot-lines"></div>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Glide duration</div>
        <div class="description">How long new lines take to slide into place</div>
    </div>
    <div class="ot-range">
        <input type="range" class="form-range" min="40" max="300" step="10"
            [(ngModel)]="s.duration" (ngModelChange)="save()">
        <span>{{ s.duration }} ms</span>
    </div>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Maximum lines per glide</div>
        <div class="description">Bigger chunks of output jump instead of gliding</div>
    </div>
    <div class="ot-range">
        <input type="range" class="form-range" min="1" max="10" step="1"
            [(ngModel)]="s.maxLines" (ngModelChange)="save()">
        <span>{{ s.maxLines }} lines</span>
    </div>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Stream filter</div>
        <div class="description">Output that keeps scrolling longer than this (cat, builds) stops gliding until it pauses</div>
    </div>
    <div class="ot-range">
        <input type="range" class="form-range" min="100" max="2000" step="50"
            [(ngModel)]="s.streamMs" (ngModelChange)="save()">
        <span>{{ s.streamMs }} ms</span>
    </div>
</div>

<div class="form-line">
    <div class="header">
        <div class="title">Reset</div>
        <div class="description">Restore the default settings</div>
    </div>
    <button class="btn btn-secondary" (click)="reset()">Reset to defaults</button>
</div>
`

const SETTINGS_STYLES = [`
:host { display: block; }
.ot-intro { opacity: 0.75; }
.ot-preview {
    position: relative;
    height: calc(${PREVIEW_ROWS} * 1.6em);
    margin: 0 0 1.5rem;
    padding: 0 0.75rem;
    border-radius: 6px;
    overflow: hidden;
    font-family: monospace;
    background: rgba(0, 0, 0, 0.35);
}
.ot-preview.ot-off { opacity: 0.4; }
.ot-lines { position: absolute; left: 0.75rem; right: 0.75rem; bottom: 0; }
.ot-lines div { height: 1.6em; line-height: 1.6em; white-space: nowrap; opacity: 0.85; }
.ot-range { display: flex; align-items: center; gap: 0.75rem; min-width: 16rem; }
.ot-range input { flex: 1; }
.ot-range span { min-width: 4.5rem; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.8; }
`]

const PREVIEW_TEXT = [
    '$ git status', 'On branch main', 'nothing to commit, working tree clean',
    '$ ls', 'README.md  index.js  package.json', '$ uptime',
    ' 12:51:07 up 3 days,  load average: 0.21', '$ date', 'Mon Nov  9 12:51:09 CET 2026',
]

class OutputTrailSettingsComponent {
    constructor (config, element) {
        this.config = config
        this.element = element
        this.timer = null
        this.step = 0
        this.anim = null
    }

    get s () {
        return this.config.store.outputTrail
    }

    save () {
        this.config.save()
    }

    reset () {
        for (const [k, v] of Object.entries(DEFAULTS)) {
            this.s[k] = v
        }
        this.save()
    }

    ngAfterViewInit () {
        this.lines = this.element.nativeElement.querySelector('.ot-lines')
        if (!this.lines) return
        for (let i = 0; i < PREVIEW_ROWS; i++) this.addLine()
        runOutsideAngular(() => {
            this.timer = setInterval(() => this.tick(), 700)
        })
    }

    addLine () {
        const div = document.createElement('div')
        div.textContent = PREVIEW_TEXT[this.step++ % PREVIEW_TEXT.length]
        this.lines.appendChild(div)
        while (this.lines.children.length > PREVIEW_ROWS + 2) this.lines.firstChild.remove()
    }

    tick () {
        this.addLine()
        const s = normalizeSettings(this.config.store.outputTrail)
        if (!s.enabled || typeof this.lines.animate !== 'function') return
        const h = this.lines.lastChild?.offsetHeight || 0
        this.anim?.cancel()
        this.anim = this.lines.animate(
            [{ transform: `translateY(${h}px)` }, { transform: 'translateY(0)' }],
            { duration: s.duration, easing: EASING },
        )
    }

    ngOnDestroy () {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
        this.anim?.cancel()
    }
}
OutputTrailSettingsComponent.ctorParameters = () => [
    { type: ConfigService },
    { type: require('@angular/core').ElementRef },
]
Component({
    selector: 'output-trail-settings',
    template: SETTINGS_TEMPLATE,
    styles: SETTINGS_STYLES,
})(OutputTrailSettingsComponent)

class OutputTrailSettingsTabProvider extends SettingsTabProvider {
    constructor () {
        super()
        this.id = 'output-trail'
        this.icon = 'stream'
        this.title = 'Output trail'
    }

    getComponentType () {
        return OutputTrailSettingsComponent
    }
}
Injectable()(OutputTrailSettingsTabProvider)

/* ------------------------------------------------------------------ Module */

class OutputTrailModule { }
NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCore.default,
    ],
    declarations: [
        OutputTrailSettingsComponent,
    ],
    providers: [
        { provide: TerminalDecorator, useClass: OutputTrailDecorator, multi: true },
        { provide: ConfigProvider, useClass: OutputTrailConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: OutputTrailSettingsTabProvider, multi: true },
    ],
})(OutputTrailModule)

module.exports = {
    default: OutputTrailModule,
    SmoothScroller,
    OutputTrailSettingsComponent,
    normalizeSettings,
    DEFAULTS,
}

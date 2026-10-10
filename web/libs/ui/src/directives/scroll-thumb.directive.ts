import { Directive } from '@yaw-rx/core';
import type { RxElementLike } from '@yaw-rx/core';

/** Screens whose own scrollbars are overlays that fade out: phones and tablets. */
const TOUCH_SCREEN = '(pointer: coarse)';
/** The shortest the thumb gets, in pixels. */
const MIN_THUMB_PX = 24;

/**
 * A scrollbar that stays in view on touch screens, where the browser's own
 * fades out. The element it sits on scrolls; its first child becomes a
 * `.scroll-thumb` track holding the thumb (a `div`). The thumb's length is
 * the share of the content in view and its offset the scroll position, set
 * as `--scroll-thumb-height` and `--scroll-thumb-offset` on the element. The
 * track is `hidden` while the content fits or the screen is not a touch
 * screen. The element's component styles the track and the thumb.
 */
@Directive({ selector: '[scroll-thumb]' })
export class ScrollThumb {
    node!: RxElementLike;
    private track: HTMLDivElement | undefined;
    private touchScreen: MediaQueryList | undefined;
    private resizeObserver: ResizeObserver | undefined;
    private mutationObserver: MutationObserver | undefined;
    private frame = 0;

    /** One update per frame, however many changes arrive in it. */
    private readonly schedule = (): void => {
        if (this.frame !== 0) return;
        this.frame = requestAnimationFrame(this.update);
    };

    private readonly update = (): void => {
        this.frame = 0;
        const { node, track, touchScreen } = this;
        if (track === undefined || touchScreen === undefined) return;
        const { scrollHeight, clientHeight, scrollTop } = node;
        track.hidden = !touchScreen.matches || scrollHeight <= clientHeight + 1;
        if (track.hidden) return;
        const height = Math.max(MIN_THUMB_PX, (clientHeight * clientHeight) / scrollHeight);
        const offset = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height);
        node.style.setProperty('--scroll-thumb-height', `${height.toFixed(1)}px`);
        node.style.setProperty('--scroll-thumb-offset', `${offset.toFixed(1)}px`);
    };

    onInit(): void {
        const track = document.createElement('div');
        track.className = 'scroll-thumb';
        track.hidden = true;
        track.appendChild(document.createElement('div'));
        this.node.prepend(track);
        this.track = track;

        this.touchScreen = window.matchMedia(TOUCH_SCREEN);
        this.touchScreen.addEventListener('change', this.schedule);
        this.node.addEventListener('scroll', this.schedule, { passive: true });
        // The element's size, and its content as rows open, close and change.
        this.resizeObserver = new ResizeObserver(this.schedule);
        this.resizeObserver.observe(this.node);
        this.mutationObserver = new MutationObserver(this.schedule);
        this.mutationObserver.observe(this.node, { childList: true, subtree: true });
        this.schedule();
    }

    onDestroy(): void {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.touchScreen?.removeEventListener('change', this.schedule);
        this.node.removeEventListener('scroll', this.schedule);
        this.resizeObserver?.disconnect();
        this.mutationObserver?.disconnect();
        this.track?.remove();
        this.track = undefined;
    }
}

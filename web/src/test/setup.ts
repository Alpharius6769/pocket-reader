// jsdom gaps the UI relies on.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

window.scrollTo = (() => {}) as typeof window.scrollTo;
Element.prototype.scrollTo = function () {} as typeof Element.prototype.scrollTo;

// Svelte transitions use the Web Animations API.
if (!Element.prototype.animate) {
  Element.prototype.animate = function () {
    const anim = {
      onfinish: null as null | (() => void),
      cancel() {},
      finish() {},
      play() {},
      pause() {},
      currentTime: 0,
      finished: Promise.resolve(),
    };
    queueMicrotask(() => anim.onfinish?.());
    return anim as unknown as Animation;
  };
}

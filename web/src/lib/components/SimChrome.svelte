<!--
  Design-review only (?sim=iphone): draws an iPhone 16 Pro status bar and
  Dynamic Island so screenshots show real clearance. Never shipped to users.
-->
<script lang="ts"></script>

<div class="sim" aria-hidden="true">
  <span class="time">9:41</span>
  <span class="island"></span>
  <span class="right">
    <svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1" /><rect x="5" y="5.5" width="3" height="6.5" rx="1" /><rect x="10" y="3" width="3" height="9" rx="1" /><rect x="15" y="0" width="3" height="12" rx="1" /></svg>
    <svg width="26" height="12" viewBox="0 0 26 12"><rect x="0.5" y="0.5" width="22" height="11" rx="3.5" fill="none" stroke="currentColor" opacity="0.4" /><rect x="2" y="2" width="17" height="8" rx="2" /><rect x="24" y="4" width="1.5" height="4" rx="0.75" opacity="0.4" /></svg>
  </span>
</div>
<div class="home" aria-hidden="true"></div>

<style>
  .sim {
    position: fixed;
    z-index: 200;
    top: 0;
    left: 0;
    right: 0;
    height: 54px;
    pointer-events: none;
    color: var(--ink);
    font: 600 17px/1 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  }
  .time {
    position: absolute;
    left: 50px;
    top: 21px;
  }
  .island {
    position: absolute;
    left: 50%;
    top: 11px;
    width: 125px;
    height: 37px;
    transform: translateX(-50%);
    border-radius: 20px;
    background: #000;
  }
  .right {
    position: absolute;
    right: 32px;
    top: 21px;
    display: flex;
    gap: 6px;
    fill: currentColor;
  }
  .home {
    position: fixed;
    z-index: 200;
    left: 50%;
    bottom: 8px;
    width: 140px;
    height: 5px;
    border-radius: 3px;
    transform: translateX(-50%);
    background: var(--ink);
    pointer-events: none;
  }
</style>

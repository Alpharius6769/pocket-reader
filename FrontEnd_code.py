from ._anvil_designer import FrontEndTemplate
from anvil import *
from anvil.js import window

class FrontEnd(FrontEndTemplate):
  def __init__(self, **properties):
    self.init_components(**properties)

    # Guards the first-time-setup wizard retry chain so init_ui's module-load
    # polling doesn't spawn overlapping timers (see _maybe_show_setup_modal).
    self._setup_modal_kicked = False
    self._ui_initialized = False

    # Theme modules load from the form template. Do not import them here: a
    # failed dynamic module import aborts form construction before form_show(),
    # which can otherwise prevent the static first-run setup gate from running.
    # Initialize the account bridge immediately; published HtmlTemplate forms
    # do not always emit form_show before users can interact with onboarding.
    self.init_ui()

  def form_show(self, **event_args):
    self.init_ui()

  def _inject_app_icons(self):
    """
        Injects favicon and PWA icon links from the single uploaded WebP asset.
        File: pocket_reader_icon.webp  (uploaded to Anvil Assets)
        Served at: /_/theme/pocket_reader_icon.webp
        """
    doc  = window.document
    head = doc.head
    icon = '/_/theme/pocket_reader_icon.webp'

    def _link(rel, sizes, href, type_='image/webp'):
      el = doc.createElement('link')
      el.rel = rel
      if sizes:
        el.setAttribute('sizes', sizes)
      el.type = type_
      el.href = href
      head.appendChild(el)

      # Browser tab favicon (all sizes point to the same scalable WebP)
    _link('icon',             '32x32',   icon)
    _link('icon',             '192x192', icon)
    _link('icon',             '512x512', icon)
    # iOS / macOS home-screen icon
    _link('apple-touch-icon', '180x180', icon)

    # Theme colour for mobile browser chrome
    meta = doc.createElement('meta')
    meta.name = 'theme-color'
    meta.content = '#111214'
    head.appendChild(meta)

    # App name for browser bookmarks / PWA
    meta2 = doc.createElement('meta')
    meta2.name = 'application-name'
    meta2.content = 'Pocket Reader'
    head.appendChild(meta2)

  def init_ui(self):
    self._inject_app_icons()

    # Expose Anvil User and Sync functions to Javascript
    import anvil.server
    import anvil.users
    window.anvilLogin = self.anvil_login
    window.anvilLogout = self.anvil_logout
    window.anvilSyncProfile = self.anvil_sync_profile
    window.anvilLoadProfile = self.anvil_load_profile
    window.anvilSyncProfileV3 = self.anvil_sync_profile_v3
    window.anvilSaveAvatar = self.anvil_save_avatar
    window.anvilLoadAvatar = self.anvil_load_avatar
    window.anvilDeleteAccountData = self.anvil_delete_account_data
    window.anvilGetCurrentUser = self.anvil_get_current_user

    # A brand-new user must always be met by the account-creation wizard. Run
    # this check independently of the JS theme modules so a slow, failed, or
    # not-yet-ready loadLocalData can never suppress it (Issue 1). The helper
    # self-retries until the form template DOM exists (Issue 2). Kick it off
    # once — the else-branch below re-invokes init_ui while modules load, and we
    # don't want a fresh retry chain each poll.
    if not self._setup_modal_kicked:
      self._setup_modal_kicked = True
      self._maybe_show_setup_modal()

    if hasattr(window, 'loadLocalData'):
      if self._ui_initialized:
        return
      self._ui_initialized = True
      # loadLocalData is async — its continuation (avatar load, engine detection,
      # cloud sync) runs after this block.
      window.loadLocalData()
      try:
        if hasattr(window, 'initSettingsUI'):
          window.initSettingsUI()
        if hasattr(window, 'applySettings'):
          window.applySettings()
        if hasattr(window, 'showView'):
          window.showView('home-view')
        if hasattr(window, 'updateContinueReading'):
          window.updateContinueReading()
      except Exception as e:
        print("init_ui non-fatal error:", e)
    else:
      window.setTimeout(self.init_ui, 100)

  def _maybe_show_setup_modal(self, _attempt=0):
    """
        Shows the first-time setup (account-creation) wizard for any user who
        has not completed it. Deliberately independent of the JS module init
        chain so it always runs for new users (Issue 1). If the form template
        HTML has not been injected into the DOM yet, retry briefly instead of
        silently giving up (Issue 2).
    """
    try:
      # Device calibration always precedes the account/profile wizard. This is
      # local to the browser, so an existing account on a new phone still runs
      # it once before normal startup continues.
      if not window.localStorage.getItem('pr_device_setup_v2'):
        device_modal = window.document.getElementById('device-setup-modal')
        if device_modal:
          if device_modal.style.display != 'flex':
            device_modal.style.display = 'flex'
          return
        if _attempt < 50:
          window.setTimeout(lambda: self._maybe_show_setup_modal(_attempt + 1), 100)
        return
      handoff_pending = window.localStorage.getItem('pr_device_profile_handoff_v1') == 'pending'
      if window.localStorage.getItem('pr_setup_complete') == 'true' and not handoff_pending:
        return
      setup_modal = window.document.getElementById('first-time-setup-modal')
      if setup_modal:
        if hasattr(window, 'showFirstTimeProfileSetup'):
          window.showFirstTimeProfileSetup()
        elif setup_modal.style.display != 'flex':
          setup_modal.style.display = 'flex'
        if hasattr(window, 'restoreSetupDraft'):
          window.restoreSetupDraft()
        return
      # DOM not ready yet — retry for ~5s (50 x 100ms) before giving up.
      if _attempt < 50:
        window.setTimeout(lambda: self._maybe_show_setup_modal(_attempt + 1), 100)
    except Exception as e:
      print("setup modal check failed:", e)

    # =========================================================================
    # Anvil Cloud Accounts & Sync Hooks for JS
    # =========================================================================

  def anvil_get_current_user(self):
    import anvil.users
    user = anvil.users.get_user()
    if user:
      return user['email']
    return None

  def anvil_login(self):
    import anvil.users
    try:
      user = anvil.users.login_with_form()
      if user:
        return user['email']
    except Exception as e:
      print("Login cancelled or failed:", e)
    return None

  def anvil_logout(self):
    import anvil.users
    anvil.users.logout()
    return True

  def anvil_sync_profile(self, profile_data, is_syncing=False):
    """
        Receives JS profile data, safely unwraps Skulpt proxy wrappers by converting it
        to a native JSON string representation, and sends to the server layer.
        """
    import anvil.server
    import json
    from anvil.js import window
    try:
      if type(profile_data) is not str:
        profile_json_str = window.JSON.stringify(profile_data)
      else:
        profile_json_str = profile_data
      return anvil.server.call('save_user_profile', profile_json_str)
    except Exception as e:
      print("Failed to push profile to Anvil:", e)
      return False

  def anvil_sync_profile_v3(self, profile_data, base_revision=0, device_id=None):
    import anvil.server
    from anvil.js import window
    try:
      payload = profile_data if type(profile_data) is str else window.JSON.stringify(profile_data)
      result = anvil.server.call('sync_user_profile', payload, base_revision or 0, device_id)
      return window.JSON.parse(window.JSON.stringify(result))
    except Exception as e:
      print("Schema-v3 sync failed:", e)
      raise

  def anvil_save_avatar(self, data_url):
    import anvil.server
    return anvil.server.call('save_user_avatar', data_url)

  def anvil_load_avatar(self):
    import anvil.server
    return anvil.server.call('load_user_avatar')

  def anvil_delete_account_data(self, confirmation):
    import anvil.server
    return anvil.server.call('delete_user_account_data', confirmation)

  def anvil_load_profile(self):
    """
        Requests the profile from the server and returns a native JS object. To
        avoid native JS array functions (.map, .concat) crashing on Skulpt Proxy
        wrappers around Python lists, we serialize to a plain string and let the
        browser JSON-parse it into a pure native object.

        The server stores the profile as a compact JSON string, so that is the
        normal path. Older rows may hold a raw dict, so handle both — and never
        let a malformed or unserializable payload surface as an exception to the
        JS cloud-sync layer, which would make a real cloud profile look missing
        and get silently skipped (Issue 10).
        """
    import anvil.server
    import json
    from anvil.js import window
    try:
      profile = anvil.server.call('load_user_profile')
    except Exception as e:
      print("Failed to load profile from Anvil:", e)
      return None

    if not profile:
      return None

    # Normal path: server returned a JSON string.
    if isinstance(profile, str):
      try:
        return window.JSON.parse(profile)
      except Exception as e:
        print("Failed to parse cloud profile JSON:", e)
        return None

    # Legacy path: server returned a raw dict/object. Prefer Python's json;
    # fall back to the browser serializer if the object isn't json-friendly.
    try:
      return window.JSON.parse(json.dumps(profile))
    except Exception:
      try:
        return window.JSON.parse(window.JSON.stringify(profile))
      except Exception as e:
        print("Failed to normalize cloud profile object:", e)
        return None

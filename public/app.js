const state = {
  sessionToken: localStorage.getItem('finearrSession'),
  user: null,
  admin: null,
  permissions: null,
  approvals: [],
  requests: { movies: [], shows: [] },
  blacklist: { movies: [], shows: [] }
};

const views = {
  home: document.getElementById('homeView'),
  search: document.getElementById('searchView'),
  requests: document.getElementById('requestsView'),
  admin: document.getElementById('adminView')
};

const navButtons = document.querySelectorAll('.nav-item');
const plexLogin = document.getElementById('plexLogin');
const plexLoginLanding = document.getElementById('plexLoginLanding');
const adminLogin = document.getElementById('adminLogin');
const searchButton = document.getElementById('searchButton');
const searchInput = document.getElementById('searchInput');
const resultsList = document.getElementById('resultsList');
const recentList = document.getElementById('recentList');
const approvalList = document.getElementById('approvalList');
const movieRequests = document.getElementById('movieRequests');
const showRequests = document.getElementById('showRequests');
const blacklistList = document.getElementById('blacklistList');
const blacklistSearch = document.getElementById('blacklistSearch');
const profile = document.getElementById('profile');
const appRoot = document.getElementById('app');
const loginScreen = document.getElementById('loginScreen');
const loginStatus = document.getElementById('loginStatus');

let appConfig = {};

const permMovies = document.getElementById('permMovies');
const permShows = document.getElementById('permShows');
const permAuto = document.getElementById('permAuto');
const savePermissions = document.getElementById('savePermissions');
const userPermissions = document.getElementById('userPermissions');
const adminList = document.getElementById('adminList');
const newAdminUser = document.getElementById('newAdminUser');
const newAdminPass = document.getElementById('newAdminPass');
const createAdmin = document.getElementById('createAdmin');

function showLoginScreen(shouldShow) {
  loginScreen.classList.toggle('active', shouldShow);
  appRoot.classList.toggle('hidden', shouldShow);
}

function setLoginStatus(message) {
  loginStatus.textContent = message || '';
}

function setLoginButtonsDisabled(isDisabled) {
  plexLogin.disabled = isDisabled;
  plexLoginLanding.disabled = isDisabled;
}

function setActiveView(viewName) {
  Object.values(views).forEach((view) => view.classList.remove('active'));
  views[viewName].classList.add('active');
  navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewName);
  });
}

navButtons.forEach((button) => {
  button.addEventListener('click', () => setActiveView(button.dataset.view));
});

function renderProfile() {
  profile.textContent = state.user ? `Signed in as ${state.user.username}` : 'Not logged in';
}

async function loadAppConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) {
      return;
    }
    appConfig = await response.json();
    applyLoginBackground();
  } catch (error) {
    // Ignore config fetch failures; fallback styling will apply.
  }
}

function applyLoginBackground() {
  const background = state.user?.background || appConfig.defaultBackground;
  if (!background) {
    return;
  }
  const rawOpacity = appConfig.backgroundOverlayOpacity;
  const parsedOpacity = Number.isFinite(rawOpacity) ? rawOpacity : Number.parseFloat(rawOpacity);
  const opacity = Number.isFinite(parsedOpacity) ? Math.min(Math.max(parsedOpacity, 0), 1) : 0.4;
  loginScreen.style.setProperty('--login-overlay-opacity', opacity.toString());
  loginScreen.style.backgroundImage = `linear-gradient(rgba(10, 11, 20, ${opacity}), rgba(10, 11, 20, ${opacity})), url('${background}')`;
}

async function autoLogin() {
  if (!state.sessionToken) return false;
  const response = await fetch('/api/auth/plex/auto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken: state.sessionToken })
  });
  if (!response.ok) {
    localStorage.removeItem('finearrSession');
    state.sessionToken = null;
    state.user = null;
    renderProfile();
    return false;
  }
  const data = await response.json();
  state.user = data.user;
  renderProfile();
  applyLoginBackground();
  return true;
}

async function completePlexLogin(plexToken) {
  const response = await fetch('/api/auth/plex/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plexToken })
  });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Login failed');
    return;
  }
  state.sessionToken = data.sessionToken;
  state.user = data.user;
  localStorage.setItem('finearrSession', state.sessionToken);
  renderProfile();
  applyLoginBackground();
  showLoginScreen(false);
  await loadHome();
  await loadRequests();
}

async function startPlexOAuth() {
  try {
    setLoginButtonsDisabled(true);
    setLoginStatus('Opening Plex sign-in...');
    const response = await fetch('/api/auth/plex/pin', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      setLoginStatus(data.error || 'Unable to start Plex sign-in.');
      return;
    }
    const popup = window.open(data.authUrl, '_blank', 'width=900,height=700');
    setLoginStatus('Complete the login in the Plex window...');
    const startedAt = Date.now();
    const poll = setInterval(async () => {
      if (Date.now() - startedAt > 2 * 60 * 1000) {
        clearInterval(poll);
        setLoginStatus('Login timed out. Please try again.');
        setLoginButtonsDisabled(false);
        return;
      }
      const pollResponse = await fetch(`/api/auth/plex/pin/${data.id}`);
      const pollData = await pollResponse.json();
      if (!pollResponse.ok) {
        clearInterval(poll);
        setLoginStatus(pollData.error || 'Unable to confirm Plex login.');
        setLoginButtonsDisabled(false);
        return;
      }
      if (!pollData.authToken) {
        return;
      }
      clearInterval(poll);
      if (popup) {
        popup.close();
      }
      setLoginStatus('Signing you in...');
      await completePlexLogin(pollData.authToken);
      setLoginStatus('');
      setLoginButtonsDisabled(false);
    }, 3000);
  } catch (error) {
    setLoginStatus('Unable to start Plex sign-in.');
    setLoginButtonsDisabled(false);
  }
}

plexLogin.addEventListener('click', startPlexOAuth);
plexLoginLanding.addEventListener('click', startPlexOAuth);

adminLogin.addEventListener('click', async () => {
  const username = prompt('Admin username');
  const password = prompt('Admin password');
  if (!username || !password) return;
  const response = await fetch('/api/auth/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Admin login failed');
    return;
  }
  state.admin = data.admin;
  await loadPermissions();
  await loadAdminAccounts();
  alert('Admin session started');
});

searchButton.addEventListener('click', async () => {
  const query = searchInput.value.trim();
  if (!query) return;
  const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
  const data = await response.json();
  renderCards(resultsList, [...data.movies, ...data.shows]);
  setActiveView('search');
});

function renderCards(container, items) {
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<p>No results yet. Add API keys in config.json.</p>';
    return;
  }
  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <img src="${item.poster || 'https://placehold.co/300x450'}" alt="${item.title}" />
      <div class="card-body">
        <div class="card-title">${item.title}</div>
        <div class="card-meta">${item.year || ''}</div>
        <div class="card-meta">${(item.actors || []).slice(0, 5).join(', ')}</div>
        <div class="card-details">
          <p>${item.plot || ''}</p>
          ${item.imdb ? `<a href="${item.imdb}" target="_blank">IMDB</a>` : ''}
          ${item.tvdb ? `<a href="${item.tvdb}" target="_blank">TVDB</a>` : ''}
        </div>
        <div class="card-actions">
          <button class="secondary toggle">Details</button>
          <button class="glow request">Request</button>
        </div>
      </div>
    `;
    card.querySelector('.toggle').addEventListener('click', () => {
      card.classList.toggle('expanded');
    });
    card.querySelector('.request').addEventListener('click', () => requestItem(item));
    container.appendChild(card);
  });
}

async function requestItem(item) {
  if (!state.user) {
    alert('Please login with Plex first.');
    return;
  }
  const response = await fetch('/api/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: item.type === 'show' ? 'show' : 'movie',
      item,
      username: state.user.username
    })
  });
  const data = await response.json();
  if (!response.ok) {
    alert(data.error || 'Request failed');
    return;
  }
  alert(`Request ${data.status}`);
  await loadRequests();
}

async function loadPermissions() {
  const response = await fetch('/api/permissions');
  state.permissions = await response.json();
  permMovies.checked = !!state.permissions.defaults.canRequestMovies;
  permShows.checked = !!state.permissions.defaults.canRequestShows;
  permAuto.checked = !!state.permissions.defaults.autoApprove;
  renderUserPermissions();
}

function renderUserPermissions() {
  userPermissions.innerHTML = '';
  Object.entries(state.permissions.users).forEach(([username, perms]) => {
    const div = document.createElement('div');
    div.className = 'request-item';
    div.innerHTML = `
      <strong>${username}</strong>
      <label><input type="checkbox" data-user="${username}" data-key="canRequestMovies" ${perms.canRequestMovies ? 'checked' : ''} /> Movies</label>
      <label><input type="checkbox" data-user="${username}" data-key="canRequestShows" ${perms.canRequestShows ? 'checked' : ''} /> Shows</label>
      <label><input type="checkbox" data-user="${username}" data-key="autoApprove" ${perms.autoApprove ? 'checked' : ''} /> Auto-approve</label>
    `;
    div.querySelectorAll('input').forEach((input) => {
      input.addEventListener('change', async (event) => {
        const { user, key } = event.target.dataset;
        state.permissions.users[user] = {
          ...state.permissions.users[user],
          [key]: event.target.checked
        };
        await savePermissionChanges();
      });
    });
    userPermissions.appendChild(div);
  });
}

savePermissions.addEventListener('click', savePermissionChanges);

async function savePermissionChanges() {
  if (!state.permissions) return;
  const response = await fetch('/api/permissions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      defaults: {
        canRequestMovies: permMovies.checked,
        canRequestShows: permShows.checked,
        autoApprove: permAuto.checked
      },
      users: state.permissions.users
    })
  });
  state.permissions = await response.json();
  renderUserPermissions();
}

async function loadAdminAccounts() {
  const response = await fetch('/api/admin/accounts');
  const data = await response.json();
  adminList.innerHTML = '';
  data.admins.forEach((admin) => {
    const div = document.createElement('div');
    div.className = 'request-item';
    div.innerHTML = `
      <strong>${admin.username}</strong>
      <button class="secondary" data-user="${admin.username}">Reset Password</button>
      ${admin.username !== 'admin' ? `<button class="secondary" data-delete="${admin.username}">Delete</button>` : ''}
    `;
    div.querySelector('[data-user]').addEventListener('click', async () => {
      const newPassword = prompt('New password');
      if (!newPassword) return;
      await fetch(`/api/admin/accounts/${admin.username}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword })
      });
      await loadAdminAccounts();
    });
    if (admin.username !== 'admin') {
      div.querySelector('[data-delete]').addEventListener('click', async () => {
        await fetch(`/api/admin/accounts/${admin.username}`, { method: 'DELETE' });
        await loadAdminAccounts();
      });
    }
    adminList.appendChild(div);
  });
}

createAdmin.addEventListener('click', async () => {
  const username = newAdminUser.value.trim();
  const password = newAdminPass.value.trim();
  if (!username || !password) return;
  await fetch('/api/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  newAdminUser.value = '';
  newAdminPass.value = '';
  await loadAdminAccounts();
});

async function loadRequests() {
  const response = await fetch('/api/requests');
  const data = await response.json();
  state.requests = data.requests;
  state.blacklist = data.blacklist;
  state.approvals = data.approvals;
  renderRequestLists();
}

function renderRequestLists() {
  movieRequests.innerHTML = '';
  showRequests.innerHTML = '';
  blacklistList.innerHTML = '';

  state.requests.movies.forEach((entry) => renderRequestItem(entry, 'movie', movieRequests));
  state.requests.shows.forEach((entry) => renderRequestItem(entry, 'show', showRequests));
  renderBlacklist();
}

function renderRequestItem(entry, type, container) {
  const div = document.createElement('div');
  div.className = 'request-item';
  div.innerHTML = `
    <strong>${entry.title}</strong>
    <span>Requested by ${entry.requestedBy} on ${new Date(entry.requestedAt).toLocaleString()}</span>
    <div class="card-actions">
      <button class="glow" data-approve>Approve</button>
      <button class="secondary" data-deny>Deny</button>
    </div>
  `;
  div.querySelector('[data-approve]').addEventListener('click', async () => {
    await fetch(`/api/requests/${type}/${entry.id}/approve`, { method: 'POST' });
    await loadRequests();
    await loadHome();
  });
  div.querySelector('[data-deny]').addEventListener('click', async () => {
    await fetch(`/api/requests/${type}/${entry.id}/deny`, { method: 'POST' });
    await loadRequests();
  });
  container.appendChild(div);
}

function renderBlacklist() {
  const filter = blacklistSearch.value.toLowerCase();
  const items = [...state.blacklist.movies, ...state.blacklist.shows].filter((entry) =>
    entry.title.toLowerCase().includes(filter)
  );
  items.forEach((entry) => {
    const div = document.createElement('div');
    div.className = 'request-item';
    div.innerHTML = `
      <strong>${entry.title}</strong>
      <span>Denied by admin (${entry.requestedBy}) on ${new Date(entry.deniedAt).toLocaleString()}</span>
      <button class="secondary">Remove from blacklist</button>
    `;
    div.querySelector('button').addEventListener('click', async () => {
      const type = entry.type || (state.blacklist.movies.some((item) => item.id === entry.id) ? 'movie' : 'show');
      await fetch(`/api/blacklist/${type}/${entry.id}`, { method: 'DELETE' });
      await loadRequests();
    });
    blacklistList.appendChild(div);
  });
}

blacklistSearch.addEventListener('input', renderBlacklist);

async function loadHome() {
  const response = await fetch('/api/home/recent');
  const data = await response.json();
  renderCards(recentList, data.recent);
  renderCards(approvalList, data.approvals || []);
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((button) => button.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((pane) => pane.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`${tab.dataset.tab}Tab`).classList.add('active');
  });
});

(async function init() {
  showLoginScreen(true);
  await loadAppConfig();
  const loggedIn = await autoLogin();
  if (!loggedIn) {
    renderProfile();
    return;
  }
  showLoginScreen(false);
  await loadHome();
  await loadRequests();
})();

import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import https from 'https';
import express from 'express';
import chokidar from 'chokidar';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'config.json');
const dataDir = path.join(__dirname, 'data');
const imdbApiBaseUrl = 'https://api.imdbapi.dev';

const defaults = {
  admins: [{ username: 'admin', password: 'admin' }],
  users: {},
  permissions: {
    defaults: { canRequestMovies: true, canRequestShows: true, autoApprove: false },
    users: {}
  },
  requests: { movies: [], shows: [] },
  blacklist: { movies: [], shows: [] },
  approvals: []
};

async function readJson(file, fallback) {
  try {
    const content = await fs.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function loadConfig() {
  return readJson(configPath, {});
}

async function loadData(name) {
  const file = path.join(dataDir, `${name}.json`);
  const value = await readJson(file, defaults[name]);
  if (!value) return defaults[name];
  return value;
}

async function saveData(name, value) {
  const file = path.join(dataDir, `${name}.json`);
  await writeJson(file, value);
}

function buildPlexHeaders(config) {
  const plexConfig = config?.plex ?? {};
  const productName = plexConfig.productName || 'Finearr';
  const deviceName = plexConfig.deviceName || 'Finearr';
  return {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': plexConfig.clientId,
    'X-Plex-Product': productName,
    'X-Plex-Version': plexConfig.version || '1.0',
    'X-Plex-Device': plexConfig.device || 'Web',
    'X-Plex-Platform': plexConfig.platform || 'Web',
    'X-Plex-Device-Name': deviceName,
    'X-Plex-Platform-Version': plexConfig.platformVersion || '1.0'
  };
}

function createApp(state) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/config', async (_req, res) => {
    const config = await loadConfig();
    res.json({
      port: config.port,
      defaultBackground: config.defaultBackground,
      backgroundOverlayOpacity: config.backgroundOverlayOpacity
    });
  });

  app.post('/api/auth/plex/login', async (req, res) => {
    const { plexToken } = req.body;
    if (!plexToken) {
      return res.status(400).json({ error: 'Missing plexToken' });
    }
    const config = await loadConfig();
    try {
      const userInfo = await validatePlexToken(config, plexToken);
      if (!userInfo) {
        return res.status(401).json({ error: 'Invalid Plex token' });
      }
      const users = await loadData('users');
      const sessionToken = `sess_${Math.random().toString(36).slice(2)}`;
      users[userInfo.id] = {
        id: userInfo.id,
        username: userInfo.username,
        plexToken,
        sessionToken,
        background: users[userInfo.id]?.background || config.defaultBackground
      };
      await saveData('users', users);
      res.json({ sessionToken, user: users[userInfo.id] });
    } catch (error) {
      res.status(500).json({ error: 'Failed to validate Plex token' });
    }
  });

  app.post('/api/auth/plex/pin', async (_req, res) => {
    const config = await loadConfig();
    if (!config.plex?.clientId) {
      return res.status(500).json({ error: 'Missing Plex clientId in config' });
    }
    try {
      const response = await fetch(`${config.plex.authBaseUrl}/api/v2/pins?strong=true`, {
        method: 'POST',
        headers: buildPlexHeaders(config)
      });
      if (!response.ok) {
        return res.status(500).json({ error: 'Unable to create Plex PIN' });
      }
      const data = await response.json();
      const authBase = config.plex.authUrl || 'https://app.plex.tv/auth#';
      const authUrl = `${authBase}?clientID=${encodeURIComponent(
        config.plex.clientId
      )}&code=${encodeURIComponent(data.code)}&context[device][product]=Finearr&context[device][deviceName]=Finearr&context[device][platform]=Web&context[device][platformVersion]=1.0&context[device][model]=Web&context[device][version]=1.0`;
      res.json({ id: data.id, code: data.code, authUrl, expiresIn: data.expiresIn });
    } catch (error) {
      res.status(500).json({ error: 'Unable to create Plex PIN' });
    }
  });

  app.get('/api/auth/plex/pin/:id', async (req, res) => {
    const { id } = req.params;
    const config = await loadConfig();
    try {
      const response = await fetch(`${config.plex.authBaseUrl}/api/v2/pins/${id}`, {
        headers: buildPlexHeaders(config)
      });
      if (!response.ok) {
        return res.status(500).json({ error: 'Unable to check Plex PIN' });
      }
      const data = await response.json();
      res.json({ authToken: data.authToken || null, expiresIn: data.expiresIn, id: data.id });
    } catch (error) {
      res.status(500).json({ error: 'Unable to check Plex PIN' });
    }
  });

  app.post('/api/auth/plex/auto', async (req, res) => {
    const { sessionToken } = req.body;
    if (!sessionToken) {
      return res.status(400).json({ error: 'Missing sessionToken' });
    }
    const users = await loadData('users');
    const user = Object.values(users).find((entry) => entry.sessionToken === sessionToken);
    if (!user) {
      return res.status(401).json({ error: 'Invalid session' });
    }
    const config = await loadConfig();
    const userInfo = await validatePlexToken(config, user.plexToken);
    if (!userInfo) {
      delete users[user.id];
      await saveData('users', users);
      return res.status(401).json({ error: 'Plex account not found' });
    }
    res.json({ user });
  });

  app.post('/api/auth/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const admins = await loadData('admins');
    const admin = admins.find((entry) => entry.username === username && entry.password === password);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    res.json({ admin: { username: admin.username } });
  });

  app.get('/api/admin/accounts', async (_req, res) => {
    const admins = await loadData('admins');
    res.json({ admins: admins.map((entry) => ({ username: entry.username })) });
  });

  app.post('/api/admin/accounts', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing username or password' });
    }
    const admins = await loadData('admins');
    if (admins.some((entry) => entry.username === username)) {
      return res.status(400).json({ error: 'Admin already exists' });
    }
    admins.push({ username, password });
    await saveData('admins', admins);
    res.json({ admins: admins.map((entry) => ({ username: entry.username })) });
  });

  app.put('/api/admin/accounts/:username', async (req, res) => {
    const { username } = req.params;
    const { password } = req.body;
    const admins = await loadData('admins');
    const admin = admins.find((entry) => entry.username === username);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    admin.password = password || admin.password;
    await saveData('admins', admins);
    res.json({ admins: admins.map((entry) => ({ username: entry.username })) });
  });

  app.delete('/api/admin/accounts/:username', async (req, res) => {
    const { username } = req.params;
    if (username === 'admin') {
      return res.status(400).json({ error: 'Default admin cannot be deleted' });
    }
    const admins = await loadData('admins');
    const filtered = admins.filter((entry) => entry.username !== username);
    await saveData('admins', filtered);
    res.json({ admins: filtered.map((entry) => ({ username: entry.username })) });
  });

  app.get('/api/permissions', async (_req, res) => {
    const permissions = await loadData('permissions');
    res.json(permissions);
  });

  app.put('/api/permissions', async (req, res) => {
    const permissions = await loadData('permissions');
    const { defaults: defaultPerms, users } = req.body;
    if (defaultPerms) {
      permissions.defaults = { ...permissions.defaults, ...defaultPerms };
    }
    if (users) {
      permissions.users = { ...permissions.users, ...users };
    }
    await saveData('permissions', permissions);
    res.json(permissions);
  });

  app.get('/api/search', async (req, res) => {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Missing query' });
    }
    const results = await searchMedia(query.toString());
    res.json(results);
  });

  app.get('/api/home/recent', async (_req, res) => {
    const items = await loadRecentItems();
    res.json(items);
  });

  app.get('/api/requests', async (_req, res) => {
    const requests = await loadData('requests');
    const approvals = await loadData('approvals');
    const blacklist = await loadData('blacklist');
    res.json({ requests, approvals, blacklist });
  });

  app.post('/api/requests', async (req, res) => {
    const { type, item, username } = req.body;
    const permissions = await loadData('permissions');
    const userPerms = permissions.users[username] || permissions.defaults;
    const requests = await loadData('requests');
    const approvals = await loadData('approvals');
    const blacklist = await loadData('blacklist');

    if (!userPerms[`canRequest${type === 'movie' ? 'Movies' : 'Shows'}`]) {
      return res.status(403).json({ error: 'User does not have permission' });
    }

    const entry = {
      ...item,
      type,
      requestedBy: username,
      requestedAt: new Date().toISOString()
    };

    if (userPerms.autoApprove) {
      approvals.unshift({ ...entry, type });
      await saveData('approvals', approvals.slice(0, 20));
      await sendToDownloader(type, item);
      return res.json({ status: 'approved', entry });
    }

    requests[type === 'movie' ? 'movies' : 'shows'].push(entry);
    await saveData('requests', requests);
    await saveData('blacklist', blacklist);
    res.json({ status: 'pending', entry });
  });

  app.post('/api/requests/:type/:id/approve', async (req, res) => {
    const { type, id } = req.params;
    const requests = await loadData('requests');
    const approvals = await loadData('approvals');
    const listKey = type === 'movie' ? 'movies' : 'shows';
    const index = requests[listKey].findIndex((entry) => entry.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const entry = requests[listKey].splice(index, 1)[0];
    approvals.unshift({ ...entry, type });
    await saveData('requests', requests);
    await saveData('approvals', approvals.slice(0, 20));
    await sendToDownloader(type, entry);
    res.json({ status: 'approved', entry });
  });

  app.post('/api/requests/:type/:id/deny', async (req, res) => {
    const { type, id } = req.params;
    const requests = await loadData('requests');
    const blacklist = await loadData('blacklist');
    const listKey = type === 'movie' ? 'movies' : 'shows';
    const index = requests[listKey].findIndex((entry) => entry.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const entry = requests[listKey].splice(index, 1)[0];
    blacklist[listKey].push({
      ...entry,
      type,
      deniedAt: new Date().toISOString()
    });
    await saveData('requests', requests);
    await saveData('blacklist', blacklist);
    res.json({ status: 'denied', entry });
  });

  app.delete('/api/blacklist/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const blacklist = await loadData('blacklist');
    const listKey = type === 'movie' ? 'movies' : 'shows';
    blacklist[listKey] = blacklist[listKey].filter((entry) => entry.id !== id);
    await saveData('blacklist', blacklist);
    res.json({ status: 'removed' });
  });

  app.post('/api/users/background', async (req, res) => {
    const { username, background } = req.body;
    const users = await loadData('users');
    const user = Object.values(users).find((entry) => entry.username === username);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    user.background = background;
    await saveData('users', users);
    res.json({ status: 'updated', background });
  });

  return app;
}

async function validatePlexToken(config, plexToken) {
  const response = await fetch(config.plex.validateUrl, {
    headers: {
      [config.plex.tokenHeader]: plexToken,
      ...buildPlexHeaders(config),
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return { id: data.id?.toString(), username: data.username || data.email };
}

async function searchMedia(query) {
  const imdbResults = await searchImdb(query);
  return {
    query,
    movies: imdbResults.movies,
    shows: imdbResults.shows
  };
}

async function searchImdb(query) {
  const data = await fetchImdbApi(`/search/titles?query=${encodeURIComponent(query)}&limit=20`);
  const titles = data?.titles ?? [];
  const movieTypes = new Set(['MOVIE', 'movie']);
  const showTypes = new Set(['TV_SERIES', 'TV_MINI_SERIES', 'TV_SPECIAL', 'TV_MOVIE', 'tvSeries', 'tvMiniSeries', 'tvSpecial', 'tvMovie']);
  const movies = titles.filter((title) => movieTypes.has(title.type)).slice(0, 10);
  const shows = titles.filter((title) => showTypes.has(title.type)).slice(0, 10);
  return {
    movies: await buildImdbResults(movies, 'movie'),
    shows: await buildImdbResults(shows, 'show')
  };
}

async function buildImdbResults(titles, type) {
  return Promise.all(
    titles.map(async (title) => {
      const actors = await fetchImdbActors(title.id);
      return {
        id: title.id,
        title: title.primaryTitle || title.originalTitle,
        year: title.startYear,
        poster: title.primaryImage?.url,
        plot: title.plot,
        actors,
        imdb: title.id ? `https://www.imdb.com/title/${title.id}` : null,
        type
      };
    })
  );
}

async function fetchImdbActors(titleId) {
  if (!titleId) {
    return [];
  }
  const data = await fetchImdbApi(
    `/titles/${encodeURIComponent(titleId)}/credits?categories=actor&categories=actress&pageSize=5`
  );
  return (data?.credits || [])
    .map((credit) => credit.name?.displayName)
    .filter(Boolean)
    .slice(0, 5);
}

async function fetchImdbApi(pathname) {
  try {
    const response = await fetch(`${imdbApiBaseUrl}${pathname}`, {
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    return null;
  }
}

async function loadRecentItems() {
  const data = await fetchImdbApi(
    '/titles?types=MOVIE&sortBy=SORT_BY_RELEASE_DATE&sortOrder=DESC'
  );
  const recent = (data?.titles || []).slice(0, 20).map((item) => ({
    id: item.id,
    title: item.primaryTitle || item.originalTitle,
    year: item.startYear,
    poster: item.primaryImage?.url
  }));
  return { recent, approvals: await loadData('approvals') };
}

async function sendToDownloader(type, item) {
  const config = await loadConfig();
  const target = type === 'movie' ? config.radarr : config.sonarr;
  if (!target.baseUrl || !target.apiKey) {
    return;
  }
  const url = new URL(type === 'movie' ? '/api/v3/movie' : '/api/v3/series', target.baseUrl);
  await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': target.apiKey
    },
    body: JSON.stringify(item)
  });
}

async function startServer() {
  const config = await loadConfig();
  const state = {};
  const app = createApp(state);

  let server;

  const createServerInstance = async () => {
    const refreshedConfig = await loadConfig();
    if (refreshedConfig.ssl?.enabled) {
      const certOptions = {
        key: await fs.readFile(refreshedConfig.ssl.keyPath),
        cert: await fs.readFile(refreshedConfig.ssl.certPath)
      };
      if (refreshedConfig.ssl.caPath) {
        certOptions.ca = await fs.readFile(refreshedConfig.ssl.caPath);
      }
      return https.createServer(certOptions, app);
    }
    return http.createServer(app);
  };

  server = await createServerInstance();
  server.listen(config.port, () => {
    console.log(`Finearr running on port ${config.port}`);
  });

  if (config.ssl?.enabled) {
    const watcher = chokidar.watch([config.ssl.keyPath, config.ssl.certPath, config.ssl.caPath].filter(Boolean), {
      ignoreInitial: true
    });
    let timer;
    watcher.on('change', async () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        server.close(async () => {
          server = await createServerInstance();
          server.listen(config.port, () => {
            console.log('SSL certificates reloaded.');
          });
        });
      }, 10000);
    });
  }
}

startServer();

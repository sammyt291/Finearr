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

function createApp(state) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/config', async (_req, res) => {
    const config = await loadConfig();
    res.json({
      port: config.port,
      defaultBackground: config.defaultBackground
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
    const config = await loadConfig();
    const results = await searchMedia(config, query.toString());
    res.json(results);
  });

  app.get('/api/home/recent', async (_req, res) => {
    const config = await loadConfig();
    const items = await loadRecentItems(config);
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
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return { id: data.id?.toString(), username: data.username || data.email };
}

async function searchMedia(config, query) {
  const omdbResults = await searchOmdb(config, query);
  const tvdbResults = await searchTvdb(config, query);
  return {
    query,
    movies: omdbResults,
    shows: tvdbResults
  };
}

async function searchOmdb(config, query) {
  if (!config.omdb.apiKey) {
    return [];
  }
  const response = await fetch(`https://www.omdbapi.com/?apikey=${config.omdb.apiKey}&s=${encodeURIComponent(query)}&type=movie`);
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  if (!data.Search) {
    return [];
  }
  return Promise.all(
    data.Search.map(async (item) => {
      const detailResponse = await fetch(`https://www.omdbapi.com/?apikey=${config.omdb.apiKey}&i=${item.imdbID}`);
      const detail = await detailResponse.json();
      const actors = detail.Actors ? detail.Actors.split(',').slice(0, 5) : [];
      return {
        id: item.imdbID,
        title: item.Title,
        year: item.Year,
        poster: item.Poster,
        plot: detail.Plot,
        actors,
        imdb: `https://www.imdb.com/title/${item.imdbID}`,
        type: 'movie'
      };
    })
  );
}

async function searchTvdb(config, query) {
  if (!config.tvdb.apiKey) {
    return [];
  }
  const response = await fetch(`https://api4.thetvdb.com/v4/search?query=${encodeURIComponent(query)}&type=series`, {
    headers: {
      Authorization: `Bearer ${config.tvdb.apiKey}`
    }
  });
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return (data.data || []).slice(0, 10).map((item) => ({
    id: item.tvdb_id?.toString() || item.id?.toString(),
    title: item.name,
    year: item.year,
    poster: item.image_url,
    plot: item.overview,
    actors: [],
    tvdb: `https://thetvdb.com/series/${item.slug}`,
    type: 'show'
  }));
}

async function loadRecentItems(config) {
  if (!config.omdb.apiKey) {
    return { recent: [], approvals: await loadData('approvals') };
  }
  const response = await fetch(`https://www.omdbapi.com/?apikey=${config.omdb.apiKey}&s=2024&type=movie`);
  const data = await response.json();
  const recent = (data.Search || []).slice(0, 20).map((item) => ({
    id: item.imdbID,
    title: item.Title,
    year: item.Year,
    poster: item.Poster
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

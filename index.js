const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const babel = require('babel-core');
const micromatch = require('micromatch');
const {promisify} = require('util');
const {loggerBuilder} = require('./utils');

const transformFile = promisify(babel.transformFile);

module.exports = function middlewareBuilder(options = {}) {

  async function fileLastModifiedHash(path) {
    const mtime = (await fs.lstat(path)).mtime.getTime();
    return crypto.createHash('md5').update(`${mtime}-${path}`).digest('hex');
  }

  function handleError(res, error) {
    if (webConsoleErrors) {
      const errOutput = String(error).replace(/'/g, '\\\'').replace(/"/g, '\\"');
      res.send(`
        /* Babel parsing error from babel-middleware-stzhang
           See error console output for details. */
        var output = ${JSON.stringify(error)};
        console.error("${errOutput}", output.codeFrame);
      `);
    } else {
      res.status(500).send(error);
    }
    res.end();
  }

  function pathForHash(hash) {
    return path.resolve(`${cachePath}/${hash}.js`);
  }

  const srcPath = options.srcPath;
  const cachePath = options.cachePath || 'memory';
  const isMemoryCache = cachePath === 'memory';
  const exclude = options.exclude || [];
  const debug = options.debug || false;
  const webConsoleErrors = options.consoleErrors || false;
  const hashMap = {}; // filename to last known hash map
  const cacheMap = {}; // hash to transpiled file contents map
  const waitUtils = Promise.all([
    fs.access('.babelrc').then(() => fs.readFile('.babelrc').then(babelOptions => Object.assign(JSON.parse(babelOptions), {
      'sourceMaps': 'inline',
      'highlightCode': false
    })), () => ({
      'stage': 0
    })),
    isMemoryCache ? Promise.resolve() : fs.mkdir(cachePath).catch(err => err)
  ]);

  return async function (req, res) { // eslint-disable-line complexity
    const logDebug = loggerBuilder.debug('express');
    const src = path.resolve(`${srcPath}/${req.path}`);
    const sendFile = promisify(res.sendFile).bind(res);
    const [
      [babelOptions], hash
    ] = await Promise.all([
      waitUtils,
      fileLastModifiedHash(src)
    ]);
    let lastKnownHash = hashMap[src];
    let hashPath;

    if (exclude.length) {
      if (micromatch.any(req.path.replace(/^\/+|\/+$/g, ''), exclude)) {
        logDebug('Excluded: %s (%s)', req.path, exclude);
        res.append('X-Babel-Cache', false);
        try {
          await sendFile(src, {});
        } catch (err) {
          handleError(res, err);
        }
        return;
      }
    }

    logDebug('Preparing: %s (%s)', src, hash);

    res.append('X-Babel-Cache', true);
    res.append('X-Babel-Cache-Hash', hash);

    if (!isMemoryCache) {
      hashPath = pathForHash(hash);
      try {
        await fs.stat(hashPath);
        hashMap[src] = lastKnownHash = hash;
      } catch (e) {
        // do nothing
      }
    }

    if (lastKnownHash && lastKnownHash === hash) {
      // file unchanged, exit early
      let cacheMiss = false;
      if (!isMemoryCache) {
        try {
          await fs.lstat(hashPath);
        } catch (e) {
          cacheMiss = true;
        }

        // Ensure Cache directory exists
        if (cacheMiss) {
          try {
            await fs.lstat(cachePath);
          } catch (e) {
            await fs.mkdir(cachePath);
          }
        }
      }

      if (!cacheMiss) {
        res.append('X-Babel-Cache-Hit', true);
        if (isMemoryCache) {
          logDebug('Serving (cached): %s', src);
          res.write(cacheMap[hash]);
          res.end();
        } else {
          logDebug('Serving (cached): %s', hashPath);
          try {
            await sendFile(hashPath, {});
          } catch (err) {
            handleError(res, err);
          }
        }
        return;
      }
    }

    res.append('X-Babel-Cache-Hit', false);

    if (isMemoryCache && lastKnownHash && lastKnownHash in cacheMap) {
      Reflect.deleteProperty(cacheMap, lastKnownHash);
    } else if (!isMemoryCache && lastKnownHash) {
      try {
        await fs.unlink(pathForHash(lastKnownHash));
      } catch (e) {
        // do nothing
      }
    }

    let result;
    try {
      result = await transformFile(src, babelOptions);
    } catch (e) {
      handleError(res, e);
      return;
    }

    const code = result.code;
    hashMap[src] = hash;

    if (isMemoryCache) {
      cacheMap[hash] = code;
    } else {
      try {
        await fs.writeFile(hashPath, code);
      } catch (err) {
        console.error(`Error saving ${hashPath}: ${err}`);
        Reflect.deleteProperty(hashMap, src);
      }
    }
    logDebug('Serving (uncached): %s', src);
    res.write(code);
    res.end();
  };
};

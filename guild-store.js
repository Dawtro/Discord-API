const fs = require('fs');
const path = require('path');

const storePath = path.join(__dirname, 'guild-config.json');

function loadStore() {
    try {
        const value = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        return value && typeof value === 'object' ? value : {};
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('[Guild Store] Could not load configuration:', error.message);
        }
        return {};
    }
}

function saveStore(store) {
    const temporaryPath = `${storePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(store, null, 2));
    fs.renameSync(temporaryPath, storePath);
}

function getGuild(guildId) {
    return loadStore()[guildId] || null;
}

function saveGuild(guildId, updates) {
    const store = loadStore();
    const current = store[guildId] || {
        guildId,
        active: false,
        createdAt: new Date().toISOString()
    };

    store[guildId] = {
        ...current,
        ...updates,
        guildId,
        updatedAt: new Date().toISOString()
    };
    saveStore(store);
    return store[guildId];
}

function deleteGuild(guildId) {
    const store = loadStore();
    delete store[guildId];
    saveStore(store);
}

module.exports = {
    deleteGuild,
    getGuild,
    saveGuild
};

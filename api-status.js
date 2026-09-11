require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
    Client,
    ContainerBuilder,
    GatewayIntentBits,
    MessageFlags,
    SeparatorBuilder,
    TextDisplayBuilder
} = require('discord.js');
const axios = require('axios');

const token = process.env.DISCORD_TOKEN;
const erlcKey = process.env.ERLC_SERVER_KEY;
const apiStatusChannelId = '1546978635712299040';
const updateIntervalMs = 60_000;
const probeTimeoutMs = 10_000;
const historyFile = path.join(__dirname, 'api-status-history.json');
const rollingWindowMs = 90 * 24 * 60 * 60 * 1000;
const robloxHealthUrl = 'https://users.roblox.com/v1/users/1';
const erlcHealthUrl = 'https://api.erlc.gg/v2/server';
const statusMarker = 'API_STATUS_MONITOR';

const services = {
    roblox: createServiceState('Roblox API'),
    erlc: createServiceState('ER:LC API')
};

const history = loadHistory();
services.roblox.outages = history.roblox.outages;
services.erlc.outages = history.erlc.outages;
services.roblox.baselinePercentage = history.roblox.baselinePercentage;
services.erlc.baselinePercentage = history.erlc.baselinePercentage;

let statusMessage = null;
let updateInProgress = false;

function createServiceState(name) {
    return {
        name,
        operational: null,
        outageStartedAt: null,
        outages: [],
        lastCheckedAt: null,
        lastError: null
    };
}

function loadHistory() {
    try {
        const savedHistory = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        return {
            startedAt: savedHistory.startedAt || Date.now(),
            roblox: {
                baselinePercentage: savedHistory.roblox?.baselinePercentage ?? 99.91,
                outages: Array.isArray(savedHistory.roblox?.outages) ? savedHistory.roblox.outages : []
            },
            erlc: {
                baselinePercentage: savedHistory.erlc?.baselinePercentage ?? 99.39,
                outages: Array.isArray(savedHistory.erlc?.outages) ? savedHistory.erlc.outages : []
            }
        };
    } catch {
        return {
            startedAt: Date.now(),
            roblox: { baselinePercentage: 99.91, outages: [] },
            erlc: { baselinePercentage: 99.39, outages: [] }
        };
    }
}

function saveHistory() {
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once('clientReady', async () => {
    console.log(`[API Status] Active as ${client.user.tag}.`);
    await updateStatusMessage();
    setInterval(updateStatusMessage, updateIntervalMs);
});

async function probeRobloxApi() {
    await axios.get(robloxHealthUrl, { timeout: probeTimeoutMs });
}

async function probeErlcApi() {
    await axios.get(erlcHealthUrl, {
        headers: {
            'server-key': erlcKey.trim(),
            Accept: 'application/json'
        },
        timeout: probeTimeoutMs
    });
}

async function checkService(service, probe) {
    const checkedAt = Date.now();

    try {
        await probe();
        const openOutage = service.outages.at(-1);
        if (openOutage && !openOutage.endedAt) {
            openOutage.endedAt = checkedAt;
        }
        service.operational = true;
        service.outageStartedAt = null;
        service.lastError = null;
    } catch (error) {
        const openOutage = service.outages.at(-1);
        if (!openOutage || openOutage.endedAt) {
            service.outages.push({ startedAt: checkedAt, endedAt: null });
        }
        service.outageStartedAt = service.outages.at(-1).startedAt;
        service.operational = false;
        service.lastError = error.response?.status
            ? `HTTP ${error.response.status}`
            : error.code || error.message;
    }

    service.lastCheckedAt = checkedAt;
    saveHistory();
}

function getRollingUptime(service, now = Date.now()) {
    const windowStart = now - rollingWindowMs;
    const trackedMs = rollingWindowMs;

    const newDowntimeMs = service.outages.reduce((total, outage) => {
        const outageEnd = outage.endedAt || now;
        const overlapStart = Math.max(windowStart, outage.startedAt);
        const overlapEnd = Math.min(now, outageEnd);
        return total + Math.max(0, overlapEnd - overlapStart);
    }, 0);

    return {
        percentage: Math.max(0, service.baselinePercentage - (newDowntimeMs / trackedMs) * 100),
        trackedMs,
        downtimeMs: ((100 - service.baselinePercentage) / 100) * trackedMs + newDowntimeMs
    };
}

function formatDuration(durationMs) {
    const totalMinutes = Math.floor(durationMs / 60_000);
    const days = Math.floor(totalMinutes / 1_440);
    const hours = Math.floor((totalMinutes % 1_440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function formatService(service) {
    const state = service.operational === null
        ? 'Checking'
        : service.operational
            ? 'Operational'
            : 'Down';
    const emoji = service.operational === null ? '🟡' : service.operational ? '🟢' : '🔴';
    const uptime = getRollingUptime(service);
    const outageDetails = service.operational === false && service.outageStartedAt
        ? `\nCurrent outage: ${formatDuration(Date.now() - service.outageStartedAt)}`
        : '';
    const errorDetails = service.lastError && service.operational === false
        ? `\nLast error: ${service.lastError}`
        : '';

    return `${emoji} **${service.name}:** ${state}\nUptime/90d: ${uptime.percentage.toFixed(2)}%\nOutages: ${service.outages.length}\nTracked: ${formatDuration(uptime.trackedMs)}\nDowntime/90d: ${formatDuration(uptime.downtimeMs)}${outageDetails}${errorDetails}`;
}

async function getStatusChannel() {
    const channel = await client.channels.fetch(apiStatusChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        throw new Error('The API status channel could not be found or is not text-based.');
    }
    return channel;
}

async function findStatusMessage(channel) {
    const messages = await channel.messages.fetch({ limit: 50 });
    return messages.find((message) => (
        message.author.id === client.user.id
        && JSON.stringify(message.components).includes('Roblox & ER:LC API Status')
    )) || null;
}

async function updateStatusMessage() {
    if (updateInProgress) return;
    updateInProgress = true;

    try {
        await Promise.all([
            checkService(services.roblox, probeRobloxApi),
            checkService(services.erlc, probeErlcApi)
        ]);

        const channel = await getStatusChannel();
        if (!statusMessage) statusMessage = await findStatusMessage(channel);

        const statusContainer = new ContainerBuilder()
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## Roblox & ER:LC API Status')
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`${formatService(services.roblox)}\n\n${formatService(services.erlc)}`)
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`*API status • Updates every 60 seconds • Last updated: <t:${Math.floor(Date.now() / 1000)}:t>*`)
            );

        const payload = {
            flags: MessageFlags.IsComponentsV2,
            components: [statusContainer]
        };
        if (!statusMessage) {
            statusMessage = await channel.send(payload);
        } else {
            try {
                await statusMessage.edit(payload);
            } catch (error) {
                if (error.code !== 10008) throw error;

                console.warn('[API Status] Existing status message was missing. Creating a replacement.');
                statusMessage = await findStatusMessage(channel);
                if (statusMessage) {
                    await statusMessage.edit(payload);
                } else {
                    statusMessage = await channel.send(payload);
                }
            }
        }

        console.log(`[API Status] Updated at ${new Date().toLocaleTimeString()}.`);
    } catch (error) {
        console.error('[API Status] Update failed:', error.message);
    } finally {
        updateInProgress = false;
    }
}

if (!token || !erlcKey) {
    console.error('Missing DISCORD_TOKEN or ERLC_SERVER_KEY in .env.');
    process.exit(1);
}

client.login(token).catch((error) => {
    console.error('[API Status] Discord login failed:', error.message);
    process.exitCode = 1;
});

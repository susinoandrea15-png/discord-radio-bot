import 'dotenv/config';

import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder
} from 'discord.js';

import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    VoiceConnectionStatus,
    entersState,
    StreamType
} from '@discordjs/voice';

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import ffmpegPath from 'ffmpeg-static';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !VOICE_CHANNEL_ID) {
    console.error('ERRORE: controlla il file .env');
    process.exit(1);
}

/*
 * RADIO ITALIANE
 */
const RADIOS = {
    rtl: 'RTL 102.5',
    rds: 'RDS',
    italia: 'Radio Italia',
    deejay: 'Radio Deejay',
    radio105: 'Radio 105',
    kisskiss: 'Radio Kiss Kiss',
    capital: 'Radio Capital',
    m2o: 'm2o',
    virgin: 'Virgin Radio',
    zeta: 'Radio Zeta',
    radio24: 'Radio 24',
    subasio: 'Radio Subasio',
    numberone: 'Radio Number One',
    company: 'Radio Company',
    birikina: 'Radio Birikina'
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const player = createAudioPlayer();

let connection = null;
let currentRadio = null;
let ffmpeg = null;

/*
 * COMANDI SLASH
 */
const commands = [
    new SlashCommandBuilder()
        .setName('join')
        .setDescription('Fa entrare il bot nel canale vocale'),

    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Fa uscire il bot dal canale vocale'),

    new SlashCommandBuilder()
        .setName('radio')
        .setDescription('Riproduce una radio italiana')
        .addStringOption(option =>
            option
                .setName('nome')
                .setDescription('Scegli la radio')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    new SlashCommandBuilder()
        .setName('radio-list')
        .setDescription('Mostra tutte le radio disponibili'),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Ferma la radio'),

    new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Mostra la radio attualmente in riproduzione')
].map(command => command.toJSON());

/*
 * REGISTRA I COMANDI SLASH
 */
async function registerCommands() {

    const rest = new REST({
        version: '10'
    }).setToken(TOKEN);

    await rest.put(
        Routes.applicationGuildCommands(
            CLIENT_ID,
            GUILD_ID
        ),
        {
            body: commands
        }
    );

    console.log('✅ Comandi slash registrati!');
}

/*
 * CERCA UNA RADIO
 * Usa Radio Browser per trovare uno stream funzionante.
 */
async function findRadio(radioName) {

    const url =
        'https://de1.api.radio-browser.info/json/stations/search' +
        `?countrycode=IT` +
        `&name=${encodeURIComponent(radioName)}` +
        '&limit=20' +
        '&hidebroken=true' +
        '&order=votes' +
        '&reverse=true';

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Discord-Radio-Bot/1.0'
        }
    });

    if (!response.ok) {
        throw new Error(
            `Radio Browser ha restituito HTTP ${response.status}`
        );
    }

    const stations = await response.json();

    const workingStations = stations.filter(
        station =>
            station.url_resolved &&
            /^https?:\/\//i.test(station.url_resolved)
    );

    if (workingStations.length === 0) {
        throw new Error(
            `Non ho trovato uno stream per ${radioName}`
        );
    }

    return workingStations[0];
}

/*
 * FERMA FFMPEG
 */
function stopFFmpeg() {

    if (ffmpeg) {

        try {
            ffmpeg.kill('SIGKILL');
        } catch {}

        ffmpeg = null;
    }
}

/*
 * CREA AUDIO RESOURCE
 */
function createRadioResource(streamUrl) {

    stopFFmpeg();

    ffmpeg = spawn(
        ffmpegPath,
        [
            '-hide_banner',
            '-loglevel',
            'warning',

            '-reconnect',
            '1',
            '-reconnect_streamed',
            '1',
            '-reconnect_at_eof',
            '1',
            '-reconnect_delay_max',
            '10',

            '-i',
            streamUrl,

            '-vn',
            '-c:a',
            'libopus',
            '-b:a',
            '128k',
            '-ar',
            '48000',
            '-ac',
            '2',
            '-f',
            'ogg',

            'pipe:1'
        ],
        {
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    ffmpeg.stderr.on('data', data => {
        const message = data.toString().trim();

        if (message) {
            console.log('[FFmpeg]', message);
        }
    });

    return createAudioResource(
        ffmpeg.stdout,
        {
            inputType: StreamType.OggOpus
        }
    );
}

    ffmpeg.stderr.on('data', data => {

        const message = data
            .toString()
            .trim();

        if (message) {
            console.log('[FFmpeg]', message);
        }
    });

    const audioStream = Readable.from(
        ffmpeg.stdout
    );

    return createAudioResource(
        audioStream,
        {
            inputType: StreamType.Raw
        }
    );
}

/*
 * TROVA IL CANALE VOCALE
 */
async function getVoiceChannel() {

    const guild = await client.guilds.fetch(
        GUILD_ID
    );

    const channel = await guild.channels.fetch(
        VOICE_CHANNEL_ID
    );

    if (!channel || !channel.isVoiceBased()) {

        throw new Error(
            'VOICE_CHANNEL_ID non è un canale vocale valido.'
        );
    }

    return channel;
}

/*
 * ENTRA NEL CANALE VOCALE
 */
async function connectToVoice() {

    const channel = await getVoiceChannel();

    if (
        connection &&
        connection.state.status !==
        VoiceConnectionStatus.Destroyed
    ) {
        return connection;
    }

    connection = joinVoiceChannel({

        channelId: channel.id,

        guildId: channel.guild.id,

        adapterCreator:
            channel.guild.voiceAdapterCreator,

        selfDeaf: true,

        selfMute: false
    });

    connection.subscribe(player);

    connection.on(
        VoiceConnectionStatus.Ready,
        () => {
            console.log(
                `🎙️ Connesso a: ${channel.name}`
            );
        }
    );

    connection.on(
        VoiceConnectionStatus.Disconnected,
        async () => {

            console.log(
                '⚠️ Connessione vocale persa...'
            );

            try {

                await Promise.race([
                    entersState(
                        connection,
                        VoiceConnectionStatus.Signalling,
                        5000
                    ),

                    entersState(
                        connection,
                        VoiceConnectionStatus.Connecting,
                        5000
                    )
                ]);

            } catch {

                try {
                    connection.destroy();
                } catch {}

                connection = null;

                setTimeout(
                    reconnect,
                    5000
                );
            }
        }
    );

    return connection;
}

/*
 * RICONNESSIONE AUTOMATICA
 */
async function reconnect() {

    try {

        console.log(
            '🔄 Tentativo di riconnessione...'
        );

        await connectToVoice();

        if (currentRadio) {

            await playRadio(
                currentRadio
            );
        }

    } catch (error) {

        console.error(
            'Errore riconnessione:',
            error.message
        );

        setTimeout(
            reconnect,
            5000
        );
    }
}

/*
 * RIPRODUCI RADIO
 */
async function playRadio(radioKey) {

    if (!RADIOS[radioKey]) {

        throw new Error(
            'Radio non trovata.'
        );
    }

    const radioName =
        RADIOS[radioKey];

    console.log(
        `🔎 Cerco ${radioName}...`
    );

    const station =
        await findRadio(
            radioName
        );

    console.log(
        `📻 Stream trovato: ${station.url_resolved}`
    );

    const resource =
        createRadioResource(
            station.url_resolved
        );

    player.play(resource);

    currentRadio =
        radioKey;

    if (connection) {
        connection.subscribe(player);
    }

    console.log(
        `📻 Ora in riproduzione: ${radioName}`
    );
}

/*
 * BOT ONLINE
 */
client.once(
    'ready',
    async () => {

        console.log(
            `🤖 Bot online: ${client.user.tag}`
        );

        try {

            await registerCommands();

            console.log(
                '🚀 Avvio automatico...'
            );

            await connectToVoice();

        } catch (error) {

            console.error(
                'Errore avvio:',
                error
            );

            reconnect();
        }
    }
);

/*
 * INTERAZIONI
 */
client.on(
    'interactionCreate',
    async interaction => {

        /*
         * AUTOCOMPLETE
         */
        if (interaction.isAutocomplete()) {

            const search =
                interaction.options
                    .getFocused()
                    .toLowerCase();

            const choices =
                Object.entries(RADIOS)
                    .filter(
                        ([key, name]) =>
                            key.includes(search) ||
                            name
                                .toLowerCase()
                                .includes(search)
                    )
                    .slice(0, 25)
                    .map(
                        ([key, name]) => ({
                            name,
                            value: key
                        })
                    );

            await interaction.respond(
                choices
            );

            return;
        }

        /*
         * SOLO COMANDI SLASH
         */
        if (
            !interaction.isChatInputCommand()
        ) {
            return;
        }

        try {

            /*
             * JOIN
             */
            if (
                interaction.commandName ===
                'join'
            ) {

                await connectToVoice();

                await interaction.reply(
                    '🎙️ Sono entrato nel canale vocale!'
                );

                return;
            }

            /*
             * LEAVE
             */
            if (
                interaction.commandName ===
                'leave'
            ) {

                stopFFmpeg();

                player.stop();

                currentRadio = null;

                if (connection) {

                    try {
                        connection.destroy();
                    } catch {}

                    connection = null;
                }

                await interaction.reply(
                    '👋 Sono uscito dal canale vocale.'
                );

                return;
            }

            /*
             * LISTA RADIO
             */
            if (
                interaction.commandName ===
                'radio-list'
            ) {

                const list =
                    Object.entries(RADIOS)
                        .map(
                            ([key, name]) =>
                                `\`/radio ${key}\` — ${name}`
                        )
                        .join('\n');

                await interaction.reply(
                    `📻 **Radio disponibili:**\n\n${list}`
                );

                return;
            }

            /*
             * RADIO
             */
            if (
                interaction.commandName ===
                'radio'
            ) {

                const radioKey =
                    interaction.options.getString(
                        'nome',
                        true
                    );

                await interaction.deferReply();

                if (!connection) {
                    await connectToVoice();
                }

                await playRadio(
                    radioKey
                );

                await interaction.editReply(
                    `📻 Sto riproducendo **${RADIOS[radioKey]}**!`
                );

                return;
            }

            /*
             * STOP
             */
            if (
                interaction.commandName ===
                'stop'
            ) {

                stopFFmpeg();

                player.stop();

                currentRadio = null;

                await interaction.reply(
                    '⏹️ Radio fermata. Rimango nel canale vocale.'
                );

                return;
            }

            /*
             * NOW PLAYING
             */
            if (
                interaction.commandName ===
                'nowplaying'
            ) {

                if (!currentRadio) {

                    await interaction.reply(
                        '🔇 Nessuna radio in riproduzione.'
                    );

                    return;
                }

                await interaction.reply(
                    `📻 Sto riproducendo **${RADIOS[currentRadio]}**.`
                );
            }

        } catch (error) {

            console.error(
                'Errore comando:',
                error
            );

            const message =
                '❌ Si è verificato un errore. Controlla il terminale.';

            if (
                interaction.deferred ||
                interaction.replied
            ) {

                await interaction
                    .editReply(message)
                    .catch(() => {});

            } else {

                await interaction
                    .reply({
                        content: message,
                        ephemeral: true
                    })
                    .catch(() => {});
            }
        }
    }
);

/*
 * ERRORI GLOBALI
 */
process.on(
    'unhandledRejection',
    error => {
        console.error(
            'Unhandled Rejection:',
            error
        );
    }
);

process.on(
    'uncaughtException',
    error => {
        console.error(
            'Uncaught Exception:',
            error
        );
    }
);

/*
 * AVVIA BOT
 */
client.login(TOKEN);

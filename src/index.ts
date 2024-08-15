import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';
import {
  createAudioPlayer,
  createAudioResource,
  type DiscordGatewayAdapterCreator,
  EndBehaviorType,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus
} from '@discordjs/voice';
import prism from 'prism-media';
import { Input, Mixer } from 'audio-mixer';
import dotenv from 'dotenv';
import { PassThrough, type Readable } from 'node:stream';

dotenv.config();


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

const listenerClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

client.once('ready', () => {
  const startCommand = new SlashCommandBuilder()
    .setName('start-sync')
    .setDescription('参戦チャンネルの音声を観戦チャンネルに流します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  const stopCommand = new SlashCommandBuilder()
    .setName('stop-sync')
    .setDescription('参戦チャンネルの音声ストップ')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  client.application?.commands.set([startCommand, stopCommand], process.env.GUILD_ID as string);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'start-sync') {
      const watchConnection = joinVoiceChannel({
        group: 'speaker',
        channelId: process.env.WATCHING_CHANNEL_ID as string,
        guildId: interaction.guild?.id as string,
        adapterCreator: client.guilds.cache.get(interaction.guild?.id as string)?.voiceAdapterCreator as DiscordGatewayAdapterCreator,
        selfMute: true,
        selfDeaf: false,
      });
      const playConnection = joinVoiceChannel({
        group: 'listener',
        channelId: process.env.PLAYING_CHANNEL_ID as string,
        guildId: interaction.guild?.id as string,
        adapterCreator: listenerClient.guilds.cache.get(interaction.guild?.id as string)?.voiceAdapterCreator as DiscordGatewayAdapterCreator,
        selfMute: false,
        selfDeaf: true,
      });
      const mixer = new Mixer({
        channels: 2,
        bitDepth: 16,
        sampleRate: 48000,
        // clearInterval: 250,
      });
      watchConnection.on(VoiceConnectionStatus.Ready, () => {
        console.log('watch connection ready');
      });
      playConnection.on(VoiceConnectionStatus.Ready, () => {
        console.log('play connection ready');
      });

      const receiver = playConnection.receiver;
      receiver.speaking.on('start', (userId) => {
        const standaloneInput = new Input({
          channels: 2,
          bitDepth: 16,
          sampleRate: 48000,
          volume: 100,
          clearInterval: 250,
        });
        mixer.addInput(standaloneInput);
        const audio = receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 100,
          },
        });

        // 後でdecoderからstandaloneInputに直接流してみる
        const rawStream = new PassThrough();
        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        audio.pipe(decoder as unknown as NodeJS.WritableStream);
        decoder.pipe(rawStream as unknown as NodeJS.WritableStream);

        rawStream.pipe(standaloneInput as unknown as NodeJS.WritableStream);
        const player = createAudioPlayer({
          behaviors: {
            noSubscriber: NoSubscriberBehavior.Play,
          },
        });
        const resource = createAudioResource(mixer as unknown as Readable,
          {
            inputType: StreamType.Raw,
          },
        );
        player.play(resource);
        watchConnection.subscribe(player);
        rawStream.on('end', () => {
          if (mixer != null) {
            mixer.removeInput(standaloneInput);
            standaloneInput.destroy();
            rawStream.destroy();
          }
        });
      });
      await interaction.reply('VCを中継を開始しました');
    } else if (interaction.commandName === 'stop-sync') {
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
listenerClient.login(process.env.DISCORD_LISTENER_BOT_TOKEN);

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type Interaction,
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

client.once('ready', async () => {
  if (!client.application) return;
  const startCommand = new SlashCommandBuilder()
    .setName('start-sync')
    .setDescription('参戦チャンネルの中継を開始します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  const stopCommand = new SlashCommandBuilder()
    .setName('stop-sync')
    .setDescription('参戦チャンネルの中継を停止します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  const muteCommand = new SlashCommandBuilder()
    .setName('mute-all-players')
    .setDescription('参戦チャンネルのメンバーをミュートにします')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  const unmuteCommand = new SlashCommandBuilder()
    .setName('unmute-all-players')
    .setDescription('参戦チャンネルのメンバーのミュートを解除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  const promises: Promise<any>[] = [];
  const commands = await client.application.commands.fetch({ guildId: process.env.GUILD_ID as string });
  const addCommands = [startCommand, stopCommand, muteCommand, unmuteCommand];

  for (const add of addCommands) {
    const existingCommand = commands.find((v) => v.name === add.name);
    if (existingCommand) {
      promises.push(existingCommand.edit(add));
    } else {
      promises.push(client.application.commands.create(add));
    }
  }

  await Promise.all(promises);
});

async function setMuteAllPlayers(interaction: Interaction, mute: boolean) {
  const channel = await interaction.guild?.channels.fetch(process.env.PLAYING_CHANNEL_ID as string);
  if (channel?.isVoiceBased()) {
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    const promises: Promise<any>[] = [];
    for (const member of channel.members) {
      if (member[1].user.bot) continue;
      promises.push(member[1].voice.setMute(mute));
    }

    await Promise.all(promises);
  }
}

let abortController: AbortController | null = null;

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'start-sync') {
      if (abortController) {
        await interaction.reply('既にVCの中継が開始されています');
        return;
      }

      abortController = new AbortController();
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

      abortController.signal.addEventListener('abort', () => {
        playConnection.destroy();
        watchConnection.destroy();
      });
    } else if (interaction.commandName === 'stop-sync') {
      if (abortController != null) {
        abortController.abort();
        abortController = null;
      }
      await interaction.reply('VCの中継を停止しました');
    } else if (interaction.commandName === 'mute-all-players') {
      await interaction.deferReply();
      await setMuteAllPlayers(interaction, true);
      await interaction.followUp('ミュートを設定しました');
    } else if (interaction.commandName === 'unmute-all-players') {
      await interaction.deferReply();
      await setMuteAllPlayers(interaction, false);
      await interaction.followUp('ミュートを設定解除しました');
    }
  }
});
client.on('shardDisconnect', () => {
  if (abortController != null) {
    abortController.abort();
    abortController = null;
  }
});
process.on('SIGINT', () => {
  if (abortController != null) {
    abortController.abort();
    abortController = null;
  }
  client.destroy();
  listenerClient.destroy();
  process.exit();
});

client.login(process.env.DISCORD_BOT_TOKEN);
listenerClient.login(process.env.DISCORD_LISTENER_BOT_TOKEN);

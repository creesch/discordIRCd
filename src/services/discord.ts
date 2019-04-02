import * as DiscordJS from "discord.js";
import * as Winston from "winston";

export class Discord {
    constructor(logger: Winston.Logger) {
        this.logger = logger;
        this.setEvents();
    }

    private logger: Winston.Logger;
    private firstConnection: boolean = false;
    private guilds: Guilds = {};

    public client = new DiscordJS.Client({
        fetchAllMembers: true,
        sync: true,
    });

    private setEvents() {
        this.client.on('debug', this.logger.debug);
        this.client.on('error', this.logger.error);
        this.client.on('reconnecting', this.logger.info);
        this.client.on('warn', this.logger.warn);
        this.client.on('ready', this.onClientReady);
    }

    private onClientReady() {
        this.fetchGuilds();
    }

    private async fetchGuilds() {
        await Promise.all(this.client.guilds.map(async guild => {
            await guild.fetchMembers();
            guild.sync();
        }));

        this.logger.info(`Logged in as ${this.client.user.username}!`);

        if (!this.firstConnection) {
            this.logger.info("Successfully reconnected to Discord");
            return;
        }

        // Get guilds and their members
        this.client.guilds
            .filter(guild => guild.available)
            .array()
            .forEach(guild => {
                if (!this.guilds.hasOwnProperty(guild.id)) {
                    this.guilds[guild.id] = {
                        lastPrivMsg: [],
                        channels: {},
                        members: {},
                    }
                }

                guild.members.array().forEach(member => {
                    const { displayName, user: { bot }, user: { discriminator } } = member;
                    const ircDisplayName = ircNickname(displayName, bot, discriminator);
                    this.guilds[guild.id].members[ircDisplayName] = member.id;
                });
            });

        // Get channels
        this.client.channels
            .filter(channel => channel.type === "text")
            .array()
            .forEach(channel => {
                // Stupid TypeScript compiler loses track of types after .array()
                const textChannel = channel as DiscordJS.TextChannel;

                const guildId = textChannel.guild.id;
                const { name, id, topic } = textChannel;

                this.guilds[guildId].channels[name] = {
                    id,
                    joined: [],
                    topic: topic || "No topic",
                };
            });

        // start IRC here
    }
}

interface Guilds {
    [key: string]: Guild;
}

interface Guild {
    lastPrivMsg: any;
    channels: Channels;
    members: Members;
}

interface Members {
    [key: string]: string;
}

interface Channels {
    [key: string]: Channel;
}

interface Channel {
    id: string;
    joined: any[];
    topic: string;
}

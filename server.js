// Configuration goes here.
require('./config.js');

// When false nothing will be logged. 
if (!configuration.DEBUG) {
    console.log = function() {};
}

const Discord = require("discord.js");
const fs = require('fs');
let net;
let netOptions = {};

if (configuration.tlsEnabled) {
    net = require('tls');
    netOptions = {
        key: fs.readFileSync(configuration.tlsOptions.keyPath),
        cert: fs.readFileSync(configuration.tlsOptions.certPath)
    };

} else {
    net = require('net');
}

let request;

if (configuration.handleCode) {
    request = require('request');
}


//
// Let's ready some variables and stuff we will use later on.
//

// Object which will contain channel information.
let ircDetails = {
    DMserver: {
        lastPRIVMSG: []
    }
};

// Since we want a seperate connection for each discord server we will need to store our sockets. 
let ircClients = [];

// Simply used to give each new socket a unique number. 
let ircClientCount = 0;

// This is used to make sure that if discord reconnects not everything is wiped. 
let discordFirstConnection = true;

// Max line lenght for irc messages. 
const maxLineLength = 510;

//
// Generic functions
//

// Function that parses irc messages. 
// Shamelessly stolen from node-irc https://github.com/aredridel/node-ircd
function parseMessage(line) {
    let message = {};
    let m = /(:[^ ]+ )?([A-Z0-9]+)(?: (.*))?/i.exec(line);
    if (!m) {
        message['error'] = 'Unable to parse message';
    } else {
        let i;
        if (m[3] && (i = m[3].indexOf(':')) !== -1) {
            let rest = m[3].slice(i + 1);
            message.params = m[3].slice(0, i - 1).split(' ');
            message.params.push(rest);
        } else {
            if (m[3]) {
                message.params = m[3].split(' ');
            } else {
                message.params = [];
            }
        }
        if (m[2]) {
            message.command = m[2].toUpperCase();
        }
        if (m[1]) {
            message.sender = m[1];
        }
    }
    return message;
}

// Returns a number based on the discord server that increases per call.
// Used to make fairly sure nicknames on irc end up being unique after being scrubbed. 
// Make nicknames work for irc. 
function ircNickname(discordDisplayName, botuser, discriminator) {
    const replaceRegex = /[^a-zA-Z0-9_\\[\]\{\}\^`\|]/g;
    const shortenRegex = /_+/g;

    if (replaceRegex.test(discordDisplayName)) {

        let newDisplayname = `${discordDisplayName.replace(replaceRegex, '_')}_${discriminator}`;
        newDisplayname = newDisplayname.replace(shortenRegex, '_');

        return botuser ? `${newDisplayname}[BOT]` : newDisplayname;

    } else {
        return botuser ? `${discordDisplayName}[BOT]` : `${discordDisplayName}_${discriminator}`;
    }
}


// Parses discord lines to make them work better on irc. 
function parseDiscordLine(line, discordID) {
    // Discord markdown parsing the lazy way. Probably fails in a bunch of different ways but at least it is easy. 
    line = line.replace(/\*\*(.*?)\*\*/g, '\x02$1\x0F');
    line = line.replace(/\*(.*?)\*/g, '\x1D$1\x0F');
    line = line.replace(/^_(.*?)\_$/g, '\x01ACTION $1\x01');
    line = line.replace(/__(.*?)__/g, '\x1F$1\x0F');

    // With the above regex we might end up with too many end characters. This replaces the, 
    line = line.replace(/\x0F{2,}/g, '\x0F');

    // Now let's replace mentions with names we can recognize. 
    const mentionUserRegex = /(<@!?\d+?>)/g;
    const mentionUserFound = line.match(mentionUserRegex);

    if (mentionUserFound) {
        mentionUserFound.forEach(function(mention) {
            const userID = mention.replace(/<@!?(\d+?)>/, '$1');
            const memberObject = discordClient.guilds.cache.get(discordID).members.get(userID);
            const displayName = memberObject.displayName;
            const isBot = memberObject.user.bot;
            const discriminator = memberObject.user.discriminator;

            const userName = ircNickname(displayName, isBot, discriminator);
            const replaceRegex = new RegExp(mention, 'g');
            if (userName) {
                line = line.replace(replaceRegex, `@${userName}`);
            }
        });
    }

    // Now let's do this again and replace mentions with roles we can recognize. 
    const mentionRoleRegex = /(<@&\d+?>)/g;
    const mentionRoleFound = line.match(mentionRoleRegex);
    if (mentionRoleFound) {
        mentionRoleFound.forEach(function(mention) {
            const roleID = mention.replace(/<@&(\d+?)>/, '$1');
            const roleObject = discordClient.guilds.cache.get(discordID).roles.cache.get(roleID);

            const replaceRegex = new RegExp(mention, 'g');
            if (roleObject) {
                const name = roleObject.name;
                line = line.replace(replaceRegex, `@${name}`);
            }
        });
    }

    // Channels are also a thing!. 
    const mentionChannelRegex = /(<#\d+?>)/g;
    const mentionChannelFound = line.match(mentionChannelRegex);
    if (mentionChannelFound) {
        mentionChannelFound.forEach(function(mention) {
            const channelID = mention.replace(/<#(\d+?)>/, '$1');
            const channelObject = discordClient.guilds.cache.get(discordID).channels.get(channelID);

            const replaceRegex = new RegExp(mention, 'g');
            if (channelObject) {
                const name = channelObject.name;
                line = line.replace(replaceRegex, `#${name}`);
            }
        });
    }

    return line;
}

// Parse irc lines to make them work better on discord.
function parseIRCLine(line, discordID, channel) {
    line = line.replace(/\001ACTION(.*?)\001/g, '_$1_');

    // Discord-style username mentions (@User)
    const mentionDiscordRegex = /(@.+?\s)/g;
    const mentionDiscordFound = line.match(mentionDiscordRegex);
    if (mentionDiscordFound) {
        mentionDiscordFound.forEach(function(mention) {
            const userNickname = mention.replace(/@(.+?)\s/, '$1');

            if (ircDetails[discordID].channels[channel].members.hasOwnProperty(userNickname)) {
                const userID = ircDetails[discordID].channels[channel].members[userNickname].id;
                const replaceRegex = new RegExp(mention, 'g');

                line = line.replace(replaceRegex, `<@!${userID}> `);
            }
        });
    }

    // IRC-style username mentions (User: at the start of the line)
    const mentionIrcRegex = /(^.+?:)/g;
    const mentionIrcFound = line.match(mentionIrcRegex);
    if (mentionIrcFound) {
        mentionIrcFound.forEach(function(mention) {
            const userNickname = mention.replace(/^(.+?):/, '$1');

            if (ircDetails[discordID].channels[channel].members.hasOwnProperty(userNickname)) {
                const userID = ircDetails[discordID].channels[channel].members[userNickname].id;
                const replaceRegex = new RegExp(mention, 'g');

                line = line.replace(replaceRegex, `<@!${userID}>`);
            }
        });
    }

    // Channel names
    const mentionChannelRegex = /(#.+?\s)/g;
    const mentionChannelFound = line.match(mentionChannelRegex);
    if (mentionChannelFound) {
        mentionChannelFound.forEach(function(mention) {
            const channelName = mention.replace(/#(.+?)\s/, '$1');

            if (ircDetails[discordID].channels.hasOwnProperty(channelName)) {
                const userID = ircDetails[discordID].channels[channelName].id;
                const replaceRegex = new RegExp(mention, 'g');

                line = line.replace(replaceRegex, `<#${userID}> `);
            }
        });
    }

    return line;
}

//
// Discord related functionality.
//

// Create our discord client. 
let discordClient = new Discord.Client({
    fetchAllMembers: true,
    sync: true
});

// Log into discord using the token defined in config.js 
discordClient.login(configuration.discordToken);

//
// Various events used for debugging. 
//

// Will log discord debug information.
discordClient.on('debug', function(info) {
    console.log('debug', info);
});

// When debugging we probably want to know about errors as well. 
discordClient.on('error', function(info) {
    console.log('error', info);
    sendGeneralNotice('Discord error.');
});

// Emitted when the Client tries to reconnect after being disconnected.
discordClient.on('reconnecting', function() {
    console.log('reconnecting');
    sendGeneralNotice('Reconnecting to Discord.');
});

// Emitted whenever the client websocket is disconnected.
discordClient.on('disconnect', function(event) {
    console.log('disconnected', event);
    sendGeneralNotice('Discord has been disconnected.');
});

// Emitted for general warnings.
discordClient.on('warn', function(info) {
    console.log('warn', info);
});

// Discord is ready. 
discordClient.on('ready', function() {

    if (configuration.matchConnectedStatus) {
        discordClient.user.setStatus('idle'); // set idle status, no clients are connected
    }

    // This is probably not needed, but since sometimes things are weird with discord.
    discordClient.guilds.cache.array().forEach(function(guild) {
        guild.members.fetch();
        // guild.sync();
    });

    console.log(`Logged in as ${discordClient.user.username}!`);

    // Lets grab some basic information we will need eventually. 
    // But only do so if this is the first time connecting. 
    if (discordFirstConnection) {
        discordFirstConnection = false;

        discordClient.guilds.cache.array().forEach(function(guild) {
            const guildID = guild.id;
            if (!ircDetails.hasOwnProperty(guildID)) {
                ircDetails[guildID] = {
                    lastPRIVMSG: [],
                    channels: {},
                    members: {}
                };
            }

            guild.members.cache.array().forEach(function(member) {
                const ircDisplayName = ircNickname(member.displayName, member.user.bot, member.user.discriminator);
                ircDetails[guildID].members[ircDisplayName] = member.id;
            });
        });


        discordClient.channels.cache.array().forEach(function(channel) {
            // Of course only for channels. 
            if (channel.type === 'text') {
                const guildID = channel.guild.id,
                  channelName = channel.name,
                    channelID = channel.id,
                 channelTopic = channel.topic || 'No topic',
                  canSetTopic = false;

                ircDetails[guildID].channels[channelName] = {
                    id: channelID,
                    joined: [],
                    topic: channelTopic,
                    canSetTopic: canSetTopic
                };

                // parse channels for topic editability
                ircDetails[guildID].channels[channelName].canSetTopic = discordClient.guilds.cache.get(guildID).me.permissionsIn(channel.id).has('MANAGE_CHANNELS', true);
                console.log(`channel: ${channel.name} - canSetTopic=${ircDetails[guildID].channels[channelName].canSetTopic}`);
            }
        });

        // Now that is done we can start the irc server side of things. 
        ircServer.listen(configuration.ircServer.listenPort);
    } else {
        sendGeneralNotice('Discord connection has been restored.');
    }
});

//
// Acting on events
//

// There are multiple events that indicate a users is no longer on the server. 
// We abuse the irc QUIT: message for this even if people are banned. 
function guildMemberNoMore(guildID, ircDisplayName, noMoreReason) {
    let found = false;
    // First we go over the channels. 
    for (let channel in ircDetails[guildID].channels) {
        if (ircDetails[guildID].channels.hasOwnProperty(channel) && ircDetails[guildID].channels[channel].joined.length > 0) {

            let channelMembers = ircDetails[guildID].channels[channel].members;
            // Within the channels we go over the members. 
            if (channelMembers.hasOwnProperty(ircDisplayName)) {
                if (!found) {
                    let memberDetails = ircDetails[guildID].channels[channel].members[ircDisplayName];
                    console.log(`User ${ircDisplayName} quit ${noMoreReason}`);
                    ircDetails[guildID].channels[channel].joined.forEach(function(socketID) {
                        sendToIRC(guildID, `:${ircDisplayName}!${memberDetails.id}@whatever QUIT :${noMoreReason}\r\n`, socketID);
                    });

                    found = true;
                }
                delete ircDetails[guildID].channels[channel].members[ircDisplayName];
            }
        }
    }

    if (noMoreReason !== 'User gone offline') {
        delete ircDetails[guildID].members[ircDisplayName];
    }
}

function guildMemberCheckChannels(guildID, ircDisplayName, guildMember) {
    // First we go over the channels. 
    for (let channel in ircDetails[guildID].channels) {
        if (ircDetails[guildID].channels.hasOwnProperty(channel) && ircDetails[guildID].channels[channel].joined.length > 0) {
            let isInDiscordChannel = false;
            let isCurrentlyInIRC = false;

            let channelDetails = ircDetails[guildID].channels[channel];
            let channelMembers = channelDetails.members;
            let channelID = channelDetails.id;

            //Let's check the discord channel. 
            let discordMemberArray = discordClient.guilds.cache.get(guildID).channels.get(channelID).members.array();
            discordMemberArray.forEach(function(discordMember) {
                if (guildMember.displayName === discordMember.displayName && (guildMember.presence.status !== 'offline' || configuration.showOfflineUsers)) {
                    isInDiscordChannel = true;
                }
            });

            // Within the channels we go over the members. 
            if (channelMembers.hasOwnProperty(ircDisplayName)) {
                // User found for channel. 
                isCurrentlyInIRC = true;
            }

            // If the user is in the discord channel but not irc we will add the user. 
            if (!isCurrentlyInIRC && isInDiscordChannel) {
                ircDetails[guildID].channels[channel].members[ircDisplayName] = {
                    discordName: guildMember.displayName,
                    discordState: guildMember.presence.status,
                    ircNick: ircDisplayName,
                    id: guildMember.id
                };

                console.log(`User ${ircDisplayName} joined ${channel}`);
                ircDetails[guildID].channels[channel].joined.forEach(function(socketID) {
                    sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever JOIN #${channel}\r\n`, socketID);

                    const socketDetails = getSocketDetails(socketID);

                    if (guildMember.presence === 'idle' && socketDetails.awayNotify) {
                        console.log(`User ${ircDisplayName} is away: Idle`);
                        sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever AWAY :Idle\r\n`, socketID);
                    }

                    if (guildMember.presence === 'dnd' && socketDetails.awayNotify) {
                        console.log(`User ${ircDisplayName} is away: Do not disturb`);
                        sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever AWAY :Do not disturb\r\n`, socketID);
                    }

                    // Unlikely to happen, but just to be sure.
                    if (guildMember.presence === 'offline' && configuration.showOfflineUsers && socketDetails.awayNotify) {
                        console.log(`User ${ircDisplayName} is offline`);
                        sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever AWAY :Offline\r\n`, socketID);
                    }
                });
            }

            // If the user is currently in irc but not in the discord channel they have left the channel. 
            if (isCurrentlyInIRC && !isInDiscordChannel) {
                ircDetails[guildID].channels[channel].joined.forEach(function(socketID) {
                    console.log(`User ${ircDisplayName} left ${channel}`);
                    sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever PART #${channel}\r\n`, socketID);
                    delete ircDetails[guildID].channels[channel].members[ircDisplayName];
                });
            }

        }
    }
}

function guildMemberNickChange(guildID, oldIrcDisplayName, newIrcDisplayName, newDiscordDisplayName) {
    // First we go over the channels. 
    let foundInChannels = false;
    let memberId;

    ircDetails[guildID].members[newIrcDisplayName] = ircDetails[guildID].members[oldIrcDisplayName];
    delete ircDetails[guildID].members[oldIrcDisplayName];

    for (let channel in ircDetails[guildID].channels) {
        if (ircDetails[guildID].channels.hasOwnProperty(channel) && ircDetails[guildID].channels[channel].joined.length > 0) {

            let channelDetails = ircDetails[guildID].channels[channel];
            let channelMembers = channelDetails.members;

            // Within the channels we go over the members. 
            if (channelMembers.hasOwnProperty(oldIrcDisplayName)) {
                let tempMember = channelMembers[oldIrcDisplayName];
                tempMember.displayName = newDiscordDisplayName;
                tempMember.ircNick = newIrcDisplayName;
                memberId = tempMember.id;
                delete ircDetails[guildID].channels[channel].members[oldIrcDisplayName];
                ircDetails[guildID].channels[channel].members[oldIrcDisplayName] = tempMember;
                foundInChannels = true;

            }
        }
    }
    if (foundInChannels) {
        console.log(`Changing nickname ${oldIrcDisplayName} into ${newIrcDisplayName}`);
        sendToIRC(guildID, `:${oldIrcDisplayName}!${memberId}@whatever NICK ${newIrcDisplayName}\r\n`);
    }
}

discordClient.on('guildMemberRemove', function(GuildMember) {
    if (ircClients.length > 0) {
        console.log('guildMemberRemove');
        const guildID = GuildMember.guild.id;
        const isBot = GuildMember.user.bot;
        const discriminator = GuildMember.user.discriminator;

        const ircDisplayName = ircNickname(GuildMember.displayName, isBot, discriminator);
        guildMemberNoMore(guildID, ircDisplayName, 'User removed');
    }
});

discordClient.on('presenceUpdate', function(oldMember, newMember) {
    if (ircClients.length > 0) {

        const guildID = newMember.guild.id;
        const isBot = newMember.user.bot;
        const discriminator = newMember.user.discriminator;

        const ircDisplayName = ircNickname(newMember.displayName, isBot, discriminator);
        const oldPresenceState = oldMember.presence.status;
        const newPresenceState = newMember.presence.status;

        if (oldPresenceState === 'offline' && !configuration.showOfflineUsers) {
            guildMemberCheckChannels(guildID, ircDisplayName, newMember);
        } else if (newPresenceState === 'offline' && !configuration.showOfflineUsers) {
            guildMemberNoMore(guildID, ircDisplayName, 'User gone offline');
        } else if (configuration.showOfflineUsers) {
            ircClients.forEach(function(socket) {
                if (socket.awayNotify) {
                    // Technically we could just do socket.writeline for these. But for consistency we go through the sendToIRC function.
                    if (newPresenceState === 'offline' && configuration.showOfflineUsers) {
                        sendToIRC(guildID, `:${ircDisplayName}!${newMember.id}@whatever AWAY :Offline\r\n`, socket.ircid);
                    } else if (newPresenceState === 'dnd') {
                        sendToIRC(guildID, `:${ircDisplayName}!${newMember.id}@whatever AWAY :Do not disturb\r\n`, socket.ircid);
                    } else if (newPresenceState === 'idle') {
                        sendToIRC(guildID, `:${ircDisplayName}!${newMember.id}@whatever AWAY :Idle\r\n`, socket.ircid);
                    } else if (oldPresenceState !== 'offline' && newPresenceState === 'online') {
                        sendToIRC(guildID, `:${ircDisplayName}!${newMember.id}@whatever AWAY\r\n`, socket.ircid);
                    }
                }
            });
        }
    }
});

discordClient.on('guildMemberUpdate', function(oldMember, newMember) {
    if (ircClients.length > 0) {
        console.log('guildMemberUpdate');
        const guildID = newMember.guild.id;
        const oldIsBot = oldMember.user.bot;
        const newIsBot = newMember.user.bot;
        const discriminator = newMember.user.discriminator;
        const oldIrcDisplayName = ircNickname(oldMember.displayName, oldIsBot, discriminator);
        const newIrcDisplayName = ircNickname(newMember.displayName, newIsBot, discriminator);
        const newDiscordDisplayName = newMember.displayName;

        if (oldIrcDisplayName !== newIrcDisplayName) {
            if (newMember.id === discordClient.user.id) {
                sendToIRC(newMember.guild.id, `:${oldIrcDisplayName}!${discordClient.user.id}@whatever NICK ${newIrcDisplayName}\r\n`);
            } else {
                guildMemberNickChange(guildID, oldIrcDisplayName, newIrcDisplayName, newDiscordDisplayName);
            }
        } else {
            guildMemberCheckChannels(guildID, newIrcDisplayName, newMember);
        }
    }
});

discordClient.on('guildMemberAdd', function(GuildMember) {
    if (ircClients.length > 0) {
        console.log('guildMemberAdd');
        const guildID = GuildMember.guild.id;
        const isBot = GuildMember.user.bot;
        const discriminator = GuildMember.user.discriminator;
        const ircDisplayName = ircNickname(GuildMember.displayName, isBot, discriminator);
        guildMemberCheckChannels(guildID, ircDisplayName, GuildMember);
    }
});

discordClient.on('channelCreate', function(newChannel) {
    if (newChannel.type === 'text') {
        const discordServerId = newChannel.guild.id;
        ircDetails[discordServerId].channels[newChannel.name] = {
            id: newChannel.id,
            members: {},
            topic: newChannel.topic || 'No topic',
            joined: []
        };
    }
});

discordClient.on('channelDelete', function(deletedChannel) {
    if (deletedChannel.type === 'text') {
        const discordServerId = deletedChannel.guild.id;
        if (ircDetails[discordServerId].channels[deletedChannel.name].joined.length > 0) {
            const PartAlertMessage = `:discordIRCd!notReallyA@User PRIVMSG #${deletedChannel.name} :#${deletedChannel.name} has been deleted \r\n`;
            sendToIRC(discordServerId, PartAlertMessage);
            const joinedSockets = ircDetails[discordServerId].channels[deletedChannel.name].joined;

            joinedSockets.forEach(function(socketID) {
                // First we inform the user in the old channelContent
                partCommand(deletedChannel.name, discordServerId, socketID);
            });

        }

        // Finally remove the channel from the list. 
        delete ircDetails[discordServerId].channels[deletedChannel.name];
    }
});

discordClient.on('channelUpdate', function(oldChannel, newChannel) {
    const discordServerId = oldChannel.guild.id;
    console.log('channel updated');
    if (oldChannel.type === 'text') {

        if (oldChannel.name !== newChannel.name) {
            console.log(`channel name changed from #${oldChannel.name} to #${newChannel.name}`);
            ircDetails[discordServerId].channels[newChannel.name] = {
                id: newChannel.id,
                members: {},
                topic: newChannel.topic || 'No topic',
                joined: [],
                canSetTopic: false
            };

            if (ircDetails[discordServerId].channels[oldChannel.name].joined.length > 0) {
                const PartAlertMessage = `:discordIRCd!notReallyA@User PRIVMSG #${oldChannel.name} :#${oldChannel.name} has been renamed to #${newChannel.name} \r\n`;
                sendToIRC(discordServerId, PartAlertMessage);
                const joinedSockets = ircDetails[discordServerId].channels[oldChannel.name].joined;

                joinedSockets.forEach(function(socketID) {
                    // First we inform the user in the old channelContent
                    partCommand(oldChannel.name, discordServerId, socketID);
                    joinCommand(newChannel.name, discordServerId, socketID);
                });
            }

            // Delete the old one.
            delete ircDetails[discordServerId].channels[oldChannel.name];
        }
    }

    // Simple topic change. 
    if (oldChannel.topic !== newChannel.topic) {
        const topic = newChannel.topic || 'No topic';

        ircClients.forEach(function(socket) {
            if (socket.discordid === discordServerId && ircDetails[discordServerId].channels[newChannel.name].joined.indexOf(socket.ircid) > -1) {

                const topicMSG = `:nobodyknows!orCares@whatever TOPIC #${newChannel.name} :${topic}\r\n`;

                sendToIRC(discordServerId, topicMSG, socket.ircid);
            }
        });
    }
    //have perms changed?
    if (oldChannel.permissionOverwrites != newChannel.permissionOverwrites) {
        // skip check for bot user existence for now, do a resync anyway
        const channels = discordClient.guilds.cache.get(oldChannel.guild.id).channels.cache.array();
        channels.forEach(function(channel) {
            if (channel.type === 'text') {
                ircDetails[oldChannel.guild.id].channels[channel.name].canSetTopic = discordClient.guilds.cache.get(oldChannel.guild.id).me.permissionsIn(channel.id).has('MANAGE_CHANNELS', true);
                console.log(`channel: ${channel.name} - canSetTopic=${ircDetails[oldChannel.guild.id].channels[channel.name].canSetTopic}`);
            }
        });
        console.log('channel-specific permissions have changed!');
    }
});

discordClient.on('roleUpdate', function(oldRole, newRole) {
    const discordServerId = oldRole.guild.id;
    console.log('role updated');
    if(oldRole.permissions !== newRole.permissions) {
        if(discordClient.guilds.cache.get(discordServerId).me.roles.has(oldRole.id)) {
            console.log(`a role we're in now has different permissions!`);

            // const nickname = ircDetails[discordID].ircDisplayName;
            const channels = discordClient.guilds.cache.get(oldRole.guild.id).channels.cache.array();

            channels.forEach(function(channel) {
                if (channel.type === 'text') {
                    // console.log(ircDetails[oldRole.guild.id].channels[channel.name].);
                    ircDetails[oldRole.guild.id].channels[channel.name].canSetTopic = discordClient.guilds.cache.get(oldRole.guild.id).me.permissionsIn(channel.id).has('MANAGE_CHANNELS', true);
                    // console.log(`channel: ${channel.name} - canSetTopic=${ircDetails[oldRole.guild.id].channels[channel.name].canSetTopic}`);
                }
            });
        }
    }
});

// Processing received messages 
discordClient.on('message', function(msg) {
    if (ircClients.length > 0 && msg.channel.type === 'text') {

        const discordServerId = msg.guild.id;

        // Webhooks don't have a member.
        let authorDisplayName;

        if (msg.member) {
            authorDisplayName = msg.member.displayName;
        } else {
            authorDisplayName = msg.author.username;
        }

        const isBot = msg.author.bot;
        const discriminator = msg.author.discriminator;
        const authorIrcName = ircNickname(authorDisplayName, isBot, discriminator);
        const channelName = msg.channel.name;

        // Doesn't really matter what socket we pick this from as long as it is connected to the discord server.
        let ownNickname = getSocketDetails(ircDetails[discordServerId].channels[channelName].joined[0]).nickname;

        let messageContent = msg.content;

        if (configuration.handleCode) {
            const codeRegex = /```(.*?)\r?\n([\s\S]*?)```/;
            const replaceRegex = /```.*?\r?\n[\s\S]*?```/;

            if (codeRegex.test(messageContent)) {
                const codeDetails = messageContent.match(codeRegex);

                // In the future I want to include the url in the message. But since the call to gist is async that doesn't fit the current structure. 
                messageContent = messageContent.replace(replaceRegex, '');
                let extension;
                let language;
                if (codeDetails[1]) {
                    language = codeDetails[1].toLowerCase();

                    switch (language) {
                        case 'javascript':
                            extension = 'js';
                            break;
                        case 'html':
                            extension = 'html';
                            break;
                        case 'css':
                            extension = 'css';
                            break;
                        case 'xml':
                            extension = 'xml';
                            break;
                        case 'python':
                            extension = 'py';
                            break;
                        case 'c#':
                            extension = 'cs';
                            break;
                        case 'c++':
                            extension = 'cc';
                            break;
                        case 'php':
                            extension = 'php';
                            break;
                        default:
                            extension = 'txt';
                            break;

                    }

                } else {
                    extension = 'txt';
                    language = 'unknown';

                }

                const gistFileName = `${authorIrcName}_code.${extension}`;

                let postBody = {
                    description: `Code block on ${msg.guild.name} in channel ${channelName} from ${authorIrcName}`,
                    public: false,
                    files: {
                    }
                };

                postBody.files[gistFileName] = {
                    'content': codeDetails[2]
                };

                let gistOptions = {
                    url: 'https://api.github.com/gists',
                    headers: {
                        'Authorization': `token ${configuration.githubToken}`,
                        'User-Agent': 'discordIRCd'
                    },
                    method: 'POST',
                    json: postBody
                };

                request(gistOptions, function(error, response, body) {

                    if (error) {
                        console.log('Gist error:', error);
                    }
                    if (!error && response.statusCode === 201) {
                        console.log(body.html_url);

                        const gistMessage = `:${authorIrcName}!${msg.author.id}@whatever PRIVMSG #${channelName} :${body.html_url}\r\n`;
                        ircDetails[discordServerId].channels[channelName].joined.forEach(function(socketID) {
                            sendToIRC(discordServerId, gistMessage, socketID);
                        });

                    } 
                    if (!error && response.statusCode !== 201) {
                        console.log('Something went wrong on the gist side of things:', response.statusCode);
                    }
                });
            }
        }

        let memberMentioned = false;
        let memberDirectlyMentioned = false;

        const ownGuildMember = discordClient.guilds.cache.get(discordServerId).members.cache.get(discordClient.user.id);

        if (msg.mentions.roles.array().length > 0) {
            ownGuildMember.roles.array().forEach(function(role) {
                if (msg.isMentioned(role)) {
                    memberMentioned = true;
                }
            });

        }

        if (msg.mentions.everyone) {
            memberMentioned = true;
        }

        // Only add it if the nickname is known. If it is undefined the client is not in the channel and will be notified through PM anyway.
        if (memberMentioned && ownNickname) {
            messageContent = `${ownNickname}: ${messageContent}`;
        }

        if (msg.mentions.users.array().length > 0) {
            if (msg.isMentioned(ownGuildMember)) {
                memberDirectlyMentioned = true;
            }
        }

        // Only act on text channels and if the user has joined them in irc or if the user is mentioned in some capacity. 
        if (ircDetails[discordServerId].channels[channelName].joined.length > 0 || memberMentioned || memberDirectlyMentioned) {

            // IRC does not handle newlines. So we split the message up per line and send them seperatly.
            const messageArray = messageContent.split(/\r?\n/);

            const attachmentArray = msg.attachments.array();
            if (attachmentArray.length > 0) {
                attachmentArray.forEach(function(attachment) {
                    const filename = attachment.filename;
                    const url = attachment.url;
                    const attachmentLine = `${filename}: ${url}`;
                    messageArray.push(attachmentLine);
                });
            }

            messageArray.forEach(function(line) {

                const messageTemplate = `:${authorIrcName}!${msg.author.id}@whatever PRIVMSG #${channelName} :`;
                const messageTemplateLength = messageTemplate.length;
                const remainingLength = maxLineLength - messageTemplateLength;

                const matchRegex = new RegExp(`[\\s\\S]{1,${remainingLength}}`, 'g');

                const linesArray = line.match(matchRegex) || [];

                linesArray.forEach(function(sendLine) {
                    // Trying to prevent messages from irc echoing back and showing twice.
                    if (ircDetails[discordServerId].lastPRIVMSG.indexOf(sendLine) < 0) {
                        const lineToSend = parseDiscordLine(sendLine, discordServerId);
                        const message = `${messageTemplate}${lineToSend}\r\n`;

                        ircDetails[discordServerId].channels[channelName].joined.forEach(function(socketID) {
                            sendToIRC(discordServerId, message, socketID);
                        });

                        // Let's make people aware they are mentioned in channels they are not in. 
                        if (memberMentioned || memberDirectlyMentioned) {
                            ircClients.forEach(function(socket) {
                                if (socket.discordid === discordServerId && ircDetails[discordServerId].channels[channelName].joined.indexOf(socket.ircid) === -1) {
                                    const message = `:discordIRCd!notReallyA@User PRIVMSG discordIRCd :#${channelName}: <${authorDisplayName}> ${lineToSend}\r\n`;
                                    sendToIRC(discordServerId, message, socket.ircid);
                                }
                            });
                        }

                    }
                });


            });
        }
    }
    if (ircClients.length > 0 && msg.channel.type === 'dm') {
        const discordServerId = 'DMserver';
        const authorDisplayName = msg.author.username;
        const authorIsBot = msg.author.bot;
        const authorDiscriminator = msg.author.discriminator;
        const authorIrcName = ircNickname(authorDisplayName, authorIsBot, authorDiscriminator);

        const recipientIsBot = msg.channel.recipient.bot;
        const recipientDiscriminator = msg.channel.recipient.discriminator;
        const recipient = ircNickname(msg.channel.recipient.username, recipientIsBot, recipientDiscriminator);
        let ownNickname;



        ircClients.forEach(function(socket) {
            if (socket.discordid === discordServerId) {
                ownNickname = socket.nickname;
            }
        });



        let messageTemplate;
        if (authorIrcName === ownNickname) {
            messageTemplate = `:${authorIrcName}!${msg.author.id}@whatever PRIVMSG ${recipient} :`;
        } else {
            messageTemplate = `:${authorIrcName}!${msg.author.id}@whatever PRIVMSG ${ownNickname} :`;
        }

        // IRC does not handle newlines. So we split the message up per line and send them seperatly.
        const messageArray = msg.content.split(/\r?\n/);



        messageArray.forEach(function(line) {



            const messageTemplateLength = messageTemplate.length;
            const remainingLength = maxLineLength - messageTemplateLength;

            const matchRegex = new RegExp(`[\\s\\S]{1,${remainingLength}}`, 'g');

            const linesArray = line.match(matchRegex) || [];

            linesArray.forEach(function(sendLine) {
                // Trying to prevent messages from irc echoing back and showing twice.
                if (ircDetails[discordServerId].lastPRIVMSG.indexOf(sendLine) < 0) {
                    const lineToSend = parseDiscordLine(sendLine, discordServerId);
                    const message = `${messageTemplate}${lineToSend}\r\n`;
                    sendToIRC(discordServerId, message);
                }
            });


        });

        const attachmentArray = msg.attachments.array();
        if (attachmentArray.length > 0) {
            attachmentArray.forEach(function(attachment) {
                const filename = attachment.filename;
                const url = attachment.url;
                const attachmentLine = `${filename}: ${url}`;

                const message = `${messageTemplate}${attachmentLine}\r\n`;
                sendToIRC(discordServerId, message);
            });
        }

    }
});

// Join command given, let's join the channel. 
function joinCommand(channel, discordID, socketID) {
    let members = '';
    let memberListLines = [];
    const nickname = ircDetails[discordID].ircDisplayName;
    const memberlistTemplate = `:${configuration.ircServer.hostname} 353 ${nickname} @ #${channel} :`;
    const memberlistTemplateLength = memberlistTemplate.length;


    if (ircDetails[discordID].channels.hasOwnProperty(channel)) {
        const channelProperties = ircDetails[discordID].channels[channel];
        const channelContent = discordClient.channels.cache.get(channelProperties.id);

        ircDetails[discordID].channels[channel].joined.push(socketID);
        ircDetails[discordID].channels[channel]['members'] = {};
        const channelTopic = channelProperties.topic;

        channelContent.members.array().forEach(function(member) {
            const isBot = member.user.bot;
            const discriminator = member.user.discriminator;
            const displayMember = ircNickname(member.displayName, isBot, discriminator);

            if (member.presence.status === 'online' ||
                member.presence.status === 'idle' ||
                member.presence.status === 'dnd' ||
                (member.presence.status === 'offline' && configuration.showOfflineUsers)) {

                ircDetails[discordID].channels[channel].members[displayMember] = {
                    discordName: member.displayName,
                    discordState: member.presence.status,
                    ircNick: displayMember,
                    id: member.id
                };
                const membersPlusDisplayMember = members ? `${members} ${displayMember}` : displayMember;
                const newLineLength = membersPlusDisplayMember.length;
                const combinedLineLength = newLineLength + memberlistTemplateLength;

                if (combinedLineLength < maxLineLength) {
                    members = membersPlusDisplayMember;
                } else {
                    memberListLines.push(members);
                    members = displayMember;
                }

            }
        });

        memberListLines.push(members);

        const joinMSG = `:${nickname} JOIN #${channel}\r\n`;
        console.log(joinMSG);
        sendToIRC(discordID, joinMSG, socketID);

        // Setting the topic.
        const topicMSG = `:${configuration.ircServer.hostname} 332 ${nickname} #${channel} :${channelTopic}\r\n`;
        console.log(topicMSG);
        sendToIRC(discordID, topicMSG, socketID);

        const todayDate = new Date();
        const seconds = todayDate.getTime() / 1000;
        const topicMSG2 = `:${configuration.ircServer.hostname} 333 ${nickname} #${channel} noboyknows!orCares@whatever ${seconds}\r\n`;
        sendToIRC(discordID, topicMSG2, socketID);

        memberListLines.forEach(function(line) {
            const memberListMSG = `${memberlistTemplate}${line}\r\n`;
            console.log(memberListMSG);
            sendToIRC(discordID, memberListMSG, socketID);
        });

        const RPL_ENDOFNAMES = `:${configuration.ircServer.hostname} 366 ${nickname} #${channel} :End of /NAMES list.\r\n`;
        console.log(RPL_ENDOFNAMES);
        sendToIRC(discordID, RPL_ENDOFNAMES, socketID);

        const socketDetails = getSocketDetails(socketID);

        if (socketDetails.awayNotify) {
            for (let key in ircDetails[discordID].channels[channel].members) {
                if (ircDetails[discordID].channels[channel].members.hasOwnProperty(key)) {

                    let member = ircDetails[discordID].channels[channel].members[key];
                    let nickname = member.ircNick;

                    switch (member.discordState) {
                        case 'idle':
                            sendToIRC(discordID, `:${nickname}!${member.id}@whatever AWAY :Idle\r\n`, socketID);
                            break;
                        case 'dnd':
                            sendToIRC(discordID, `:${nickname}!${member.id}@whatever AWAY :Do not disturb\r\n`, socketID);
                            break;
                        case 'offline':
                            if (configuration.showOfflineUsers) {
                                sendToIRC(discordID, `:${nickname}!${member.id}@whatever AWAY :Offline\r\n`, socketID);
                            }

                            break;
                    }
                }
            }
        }

        // If the amount of messages to be fetched after joining is set to 0,
        // then we just exit the function here. Nothing, besides fetching the
        // messages, happens after here, so it's okay
        const messageLimit = configuration.discord.messageLimit;
        if (messageLimit === 0) return;

        // Fetch the last n Messages
        channelContent.messages.fetch({limit: messageLimit}).then((messages) => {
            console.log(`Fetched messages for "${channel}"`);
            // For some reason the messages are not ordered. So we need to sort
            // them by creation date before we do anything.
            messages.array().sort((msgA, msgB) => {
                return msgA.createdAt - msgB.createdAt;
            }).forEach((msg) => {
                // We check if the message we're about to send has more than 1 line.
                // If it does, then we need to send them one by one. Otherwise the client
                // will try to interpret them as commands.
                const lines = msg.cleanContent.split(/\r?\n/);
                if (lines.length > 1) {
                    for (let i = 0; i < lines.length; i++) {
                        sendToIRC(discordID, `:${configuration.ircServer.hostname} PRIVMSG #${channel} ${msg.author.username} :${lines[i]}\r\n`, socketID);
                    }
                } else {
                    sendToIRC(discordID, `:${configuration.ircServer.hostname} PRIVMSG #${channel} ${msg.author.username} :${msg.cleanContent}\r\n`, socketID);
                }
            });
        });

    } else {
        const ERR_INVITEONLYCHAN = `:${configuration.ircServer.hostname} 473 ${nickname} #${channel} :Cannot join channel\r\n`;
        sendToIRC(discordID, ERR_INVITEONLYCHAN, socketID);
    }
}

// List command, let's give back a list of channels.
function listCommand(discordID, ircID) {
    if (discordID === 'DMserver') return;
    const nickname = ircDetails[discordID].ircDisplayName;
    const channels = discordClient.guilds.cache.get(discordID).channels.cache.array();
    let listResponse = [`:${configuration.ircServer.hostname} 321 ${nickname} Channel :Users Name\r\n`]; //RPL_LISTSTART

    channels.forEach(function(channel) {
        if (channel.type === 'text') {
            const channelname = channel.name,
                  memberCount = channel.members.array().length,
                 channeltopic = channel.topic;

            const channelDetails = `:${configuration.ircServer.hostname} 322 ${nickname} #${channelname} ${memberCount} :${channeltopic}\r\n`; //RPL_LIST (322)
            listResponse.push(channelDetails);
        }
    });

    const endlist = `:${configuration.ircServer.hostname} 323 ${nickname} :End of channel list.\r\n`;

    listResponse.push(endlist);

    listResponse.forEach(function(line) {
        sendToIRC(discordID, line, ircID);
    });

}

// Part command given, let's part the channel. 
function partCommand(channel, discordID, ircID) {
    const nickname = ircDetails[discordID].ircDisplayName;
    if (ircDetails[discordID].channels.hasOwnProperty(channel)) {
        // Let's clear the channel

        const socketIndex = ircDetails[discordID].channels[channel].joined.indexOf(ircID);
        if (socketIndex > -1) {
            ircDetails[discordID].channels[channel].joined.splice(socketIndex, 1);
        }

        // If no other sockets are connected we clear the channel.
        if (ircDetails[discordID].channels[channel].joined.length === 0) {
            ircDetails[discordID].channels[channel].members = {};
        }

        sendToIRC(discordID, `:${nickname}!${discordClient.user.id}@whatever PART #${channel}\r\n`, ircID);
    }
}

// List amount of users on current (Discord) guild/server
function lusersCommand(discordID, ircID) {
    let guildSize = discordClient.guilds.cache.get(discordID).memberCount;
    let offlineUserAmount = discordClient.guilds.cache.get(discordID).members.cache.filter(member => member.presence.status === "offline").size;
    let channelCount = discordClient.guilds.cache.get(discordID).channels.cache.filter(c => c.type === "text").size;

    sendToIRC(discordID, `:${configuration.ircServer.hostname} 251 ${configuration.ircServer.hostname} :There are ${guildSize} users and ${offlineUserAmount} invisible on 1 servers\r\n`, ircID);
    //sendToIRC(discordID, `:${configuration.ircServer.hostname} 252 ${configuration.ircServer.hostname} :1 operator(s) online\r\n`, ircID);
    //TODO: find out how to do actual 252 check for users that have the Administrator permission
    sendToIRC(discordID, `:${configuration.ircServer.hostname} 254 ${configuration.ircServer.hostname} :${channelCount} channels formed\r\n`, ircID);
}

function getDiscordUserFromIRC(recipient, discordID) {
    let returnmember;

    if (discordID === 'DMserver') {
        discordClient.users.array().forEach(function(user) {
            const isBot = user.bot;
            const discriminator = user.discriminator;
            const displayMember = ircNickname(user.username, isBot, discriminator);

            if (displayMember === recipient) {
                returnmember = user;
            }
        });
    } else {
        discordClient.guilds.cache.get(discordID).members.array().forEach(function(member) {
            const isBot = member.user.bot;
            const discriminator = member.user.discriminator;
            const displayMember = ircNickname(member.displayName, isBot, discriminator);

            if (displayMember === recipient) {
                returnmember = member;
            }
        });
    }
    return returnmember;
}

//
// Irc Related functionality.
//
let ircServer = net.createServer(netOptions, function(socket) {
    console.log('new socket');
    socket.setEncoding('utf8');

    ircClientCount++;
    socket.ircid = ircClientCount;
    socket.discordid = '';
    socket.nickname = '';
    socket.user = '';
    socket.pongcount = 1;
    socket.isCAPBlocked = false;
    socket.authenticated = false;
    socket.connectArray = [];
    socket.awayNotify = false;

    socket.on('error', function(error) {
        console.log('Socket error: ', error);
        socket.end();

    });
    socket.on('data', function(data) {
        console.log('data:', data);
        // Data can be multiple lines. Here we put each line in an array. 
        let dataArray = data.match(/.+/g);
        dataArray.forEach(function(line) {
            let parsedLine = parseMessage(line);

            // Dealing with IRC v3.1 capability negotiation. 
            // http://ircv3.net/specs/core/capability-negotiation-3.1.html
            // v3.2 is also available but does not seem to add anything we need. 
            if (parsedLine.command === 'CAP') {
                const capSubCommand = parsedLine.params[0];
                let nickname;
                if (socket.nickname) {
                    nickname = socket.nickname;
                } else {
                    nickname = '*';
                }
                switch (capSubCommand) {
                    case 'LS':
                        socket.isCAPBlocked = true;
                        socket.write(`:${configuration.ircServer.hostname} CAP ${nickname} LS :away-notify\r\n`);
                        break;
                    case 'LIST':
                        if (socket.awayNotify) {
                            socket.write(`:${configuration.ircServer.hostname} CAP ${nickname} LIST :away-notify\r\n`);
                        } else {
                            socket.write(`:${configuration.ircServer.hostname} CAP ${nickname} LIST :\r\n`);
                        }
                        break;
                    case 'REQ':
                        const requestedCapabilities = parsedLine.params[1];

                        if (requestedCapabilities === 'away-notify') {
                            socket.write(`:${configuration.ircServer.hostname} CAP ${nickname} ACK :away-notify\r\n`);
                            socket.awayNotify = true;

                        } else if (requestedCapabilities === '-away-notify') {
                            socket.write(`:${configuration.ircServer.hostname} CAP ${nickname} ACK :-away-notify\r\n`);
                            socket.awayNotify = false;
                        } else {
                            socket.write(`:${configuration.ircServer.hostname} CAP ${nickname} NAK :${requestedCapabilities}\r\n`);
                        }

                        socket.write(`:${configuration.ircServer.hostname} CAP ${nickname} ACK :${parsedLine.params[0]}\r\n`);

                        break;
                    case 'ACK':
                        // Not expecting this from a client at this point. However we'll leave it in here for future use. 
                        break;
                    case 'END':
                        socket.isCAPBlocked = false;
                        // Now we check if the user was already authenticated and the whole welcome thing has been send. 
                        if (socket.connectArray.length > 0) {
                            socket.connectArray.forEach(function(line) {
                                socket.write(line);
                            });
                            // And empty it. 
                            socket.connectArray = [];
                        }
                        break;

                    default:
                        // We have no idea what we are dealing with. Inform the client. 
                        socket.write(`:${configuration.ircServer.hostname} 410 * ${capSubCommand} :Invalid CAP command\r\n`);
                        break;
                }
            }

            if (!socket.authenticated) {
                switch (parsedLine.command) {
                    case 'PASS':
                        socket.discordid = parsedLine.params[0];
                        break;
                    case 'NICK':
                        socket.nickname = parsedLine.params[0];
                        break;
                    case 'USER':
                        // So different irc clients use different formats for user it seems.
                        // TODO: figure out how to properly parse this. 
                        let username = parsedLine.params[0];
                        let usernameAlternative = parsedLine.params[3];
                        socket.user = username;
                        let nickname = socket.nickname;

                        // We are abusing some irc functionality here to add a tiny bit of security. 
                        // The username the ircclient gives must match with that in the configuration.
                        // If the username is correct and the discordId can be found we are in bussiness. 
                        if (username === configuration.ircServer.username || usernameAlternative === configuration.ircServer.username) {
                            // Now we are connected let's change the nickname first to whatever it is on discord. 

                            if (socket.discordid === 'DMserver') {
                                const newuser = discordClient.user.username;
                                const discriminator = discordClient.user.discriminator;
                                const newNickname = ircNickname(newuser, false, discriminator);

                                ircDetails[socket.discordid]['discordDisplayName'] = newuser;
                                ircDetails[socket.discordid]['ircDisplayName'] = newNickname;
                                socket.user = newuser;
                                socket.nickname = newNickname;
                                socket.authenticated = true;

                                const connectArray = [
                                    `:${nickname}!${discordClient.user.id}@whatever NICK ${newNickname}\r\n`,
                                    `:${configuration.ircServer.hostname} 001 ${newNickname} :Welcome to the Discord_${discordClient.guild.name} Internet Relay Chat Network ${newNickname}\r\n`,
                                    `:${configuration.ircServer.hostname} 003 ${newNickname} :This server was created specifically for you\r\n`,
                                    `:${configuration.ircServer.hostname} 375 ${newNickname} :- ${configuration.ircServer.hostname} Message of the day - \r\n`,
                                    `:${configuration.ircServer.hostname} 376 ${newNickname} :End of /MOTD command.\r\n`
                                ];

                                connectArray.forEach(function(line) {
                                    socket.write(line);
                                });

                            } else if (discordClient.guilds.cache.get(socket.discordid)) {
                                // I am fairly certain there must be a simpler way to find out... but I haven't found it yet.
                                discordClient.guilds.cache.get(socket.discordid).members.fetch(discordClient.user.id).then(function(guildMember) {
                                    const newuser = guildMember.displayName;
                                    const discriminator = discordClient.user.discriminator;
                                    const newNickname = ircNickname(newuser, false, discriminator);

                                    ircDetails[socket.discordid]['discordDisplayName'] = newuser;
                                    ircDetails[socket.discordid]['ircDisplayName'] = newNickname;

                                    socket.user = newuser;
                                    socket.nickname = newNickname;
                                    socket.authenticated = true;

                                    if (configuration.matchConnectedStatus) {
                                        discordClient.user.setStatus('online'); // we're connected, set to Online, client is present
                                    }

                                    //console.log(`:${configuration.ircServer.hostname} NOTICE Auth :*** Looking up your hostname...\r\n`);

                                    const connectArray = [
                                    `:${nickname}!${discordClient.user.id}@whatever NICK ${newNickname}\r\n`,
                                    `:${configuration.ircServer.hostname} 001 ${newNickname} :Welcome to the Discord_${discordClient.guilds.cache.get(socket.discordid).name.replace(/ /g,"-")} Internet Relay Chat Network ${newNickname}\r\n`,
                                    `:${configuration.ircServer.hostname} 003 ${newNickname} :This server was created specifically for you\r\n`,
                                    `:${configuration.ircServer.hostname} 375 ${newNickname} :- ${configuration.ircServer.hostname} Message of the day - \r\n`,
                                    `:${configuration.ircServer.hostname} 376 ${newNickname} :End of /MOTD command.\r\n`
                                    ];

                                    // If we are waiting on CAP negotiation we write the connection array to the socket and this will be processed once proper CAP END is received.
                                    if (socket.isCAPBlocked) {
                                        socket.connectArray = connectArray;

                                    } else {
                                        connectArray.forEach(function(line) {
                                            socket.write(line);
                                        });
                                    }
                                });
                            } else {
                                // Things are not working out, let's end this. 
                                console.log(`${nickname}: Failed to connect to ${socket.discordid}`);
                                socket.write(`:${configuration.ircServer.hostname} 464 ${nickname} :Failed to connect to ${socket.discordid}. Did you forget to specify the server ID as a server pass?\r\n`);
                                socket.end();
                            }

                        } else {
                            // Things are not working out, let's end this. 
                            console.log(`${nickname}: Invalid login, expected ${configuration.ircServer.username}, got ${username} (${usernameAlternative})`);
                            socket.write(`:${configuration.ircServer.hostname} 464 ${nickname} :Invalid login.  Make sure your username matches the username set in the config.\r\n`);
                            socket.end();
                        }
                        break;
                    }

                }

                if (socket.authenticated && !socket.isCAPBlocked) {

                    switch (parsedLine.command) {
                    case 'JOIN':
                        const joinChannels = parsedLine.params[0].split(',');

                        joinChannels.forEach(function(channel) {
                            joinCommand(channel.substring(1), socket.discordid, socket.ircid);
                        });

                        break;
                    case 'PART':
                        const partChannels = parsedLine.params[0].split(',');

                        partChannels.forEach(function(channel) {
                            partCommand(channel.substring(1), socket.discordid, socket.ircid);
                        });
                        break;
                    case 'PRIVMSG':
                        const recipient = parsedLine.params[0];


                        if (recipient.startsWith('#')) {
                            const channelName = recipient.substring(1);
                            const sendLine = parseIRCLine(parsedLine.params[1], socket.discordid, channelName);

                            if (ircDetails[socket.discordid].lastPRIVMSG.length > 3) {
                                ircDetails[socket.discordid].lastPRIVMSG.shift();
                            }

                            ircDetails[socket.discordid].lastPRIVMSG.push(sendLine.trim());
                            discordClient.channels.cache.get(ircDetails[socket.discordid].channels[channelName].id).send(sendLine);
                        } else if (recipient !== 'discordIRCd') {
                            const recipientUser = getDiscordUserFromIRC(recipient, socket.discordid);
                            const sendLine = parsedLine.params[1];
                            recipientUser.send(sendLine);

                            ircDetails[socket.discordid].lastPRIVMSG.push(sendLine.trim());
                            if (ircDetails[socket.discordid].lastPRIVMSG.length > 3) {
                                ircDetails[socket.discordid].lastPRIVMSG.shift();
                            }

                            if (socket.discordid !== 'DMserver') {
                                const messageTemplate = `:${socket.nickname}!${discordClient.user.id}@whatever PRIVMSG ${recipient} :PM Send: Note that replies will not arrive here but on the PM server\r\n`;
                                socket.write(messageTemplate);
                            }
                            if (ircDetails[socket.discordid].lastPRIVMSG.length > 3) {
                                ircDetails[socket.discordid].lastPRIVMSG.shift();
                            }
                        }

                        break;
                    case 'QUIT':
                        for (let channel in ircDetails[socket.discordid].channels) {
                            if (ircDetails[socket.discordid].channels.hasOwnProperty(channel) && ircDetails[socket.discordid].channels[channel].joined.indexOf(socket.ircid) > 0) {
                                const socketIndex = ircDetails[socket.discordid].channels[channel].joined.indexOf(socket.ircid);
                                if (socketIndex > -1) {
                                    ircDetails[socket.discordid].channels[channel].joined.splice(socketIndex, 1);
                                }

                            }
                        }
                        socket.end();
                        break;
                    case 'PING':
                        socket.write(`:${configuration.ircServer.hostname} PONG ${configuration.ircServer.hostname} :${socket.pongcount}\r\n`);
                        socket.pongcount = socket.pongcount + 1;
                        break;
                    case 'LIST':
                        listCommand(socket.discordid, socket.ircid);
                        break;
                    case 'LUSERS':
                        lusersCommand(socket.discordid, socket.ircid);
                        break;
                    case 'TOPIC':
                        switch(parsedLine.params.length) {
                            case 0:
                                break;
                            case 1:
                                let topicChannelLookup = parsedLine.params[0].substring(1);
                                try {
                                    const channelTopic = discordClient.channels.cache.get(ircDetails[socket.discordid].channels[topicChannelLookup].id).topic;
                                        if(channelTopic === null) {//RPL_NOTOPIC (331)
                                            let RPL_NOTOPIC = `:${configuration.ircServer.hostname} 331 ${socket.nickname} #${topicChannelLookup} :No topic is set.\r\n`;
                                            sendToIRC(socket.discordid, RPL_NOTOPIC, socket.ircid);
                                        } else { //RPL_TOPIC (332)
                                            let RPL_TOPIC = `:${configuration.ircServer.hostname} 332 ${socket.nickname} #${topicChannelLookup} :${channelTopic}\r\n`;
                                            sendToIRC(socket.discordid, RPL_TOPIC, socket.ircid);
                                            const todayDate = new Date();
                                            const seconds = todayDate.getTime() / 1000;
                                            //RPL_TOPICWHOTIME (333)
                                            const RPL_TOPICWHOTIME = `:${configuration.ircServer.hostname} 333 ${socket.nickname} #${topicChannelLookup } nobodyknows!orCares@whatever ${seconds}\r\n`;
                                            sendToIRC(socket.discordid, RPL_TOPICWHOTIME, socket.ircid);
                                        }
                                    }
                                    catch(e) {
                                        if (e instanceof TypeError) {
                                            console.log(e);
                                            let RPL_NOSUCHCHANNEL = `:${configuration.ircServer.hostname} 403 ${socket.nickname} #${topicChannelLookup} :No such channel\r\n`;
                                            sendToIRC(socket.discordid, RPL_NOSUCHCHANNEL, socket.ircid);
                                        }
                                    }
                                    break;
                                case 2:
                                    let topicChannelSet = parsedLine.params[0].substring(1);
                                    const newTopic = parsedLine.params[1];
                                    console.log(`channel id: ${ircDetails[socket.discordid].channels[topicChannelSet].id}`);
                                    if(ircDetails[socket.discordid].channels[topicChannelSet].canSetTopic) {
                                    //if(discordClient.guilds.cache.get(socket.discordid).me.permissionsIn(ircDetails[socket.discordid].channels[topicChannelSet].id).has('MANAGE_CHANNELS', true)) {
                                        discordClient.channels.cache.get(ircDetails[socket.discordid].channels[topicChannelSet].id).setTopic(`${newTopic}`);
                                    } else  {
                                        // ERR_CHANOPRIVSNEEDED (482)
                                        console.log('No perms to set topic!');
                                        let ERR_CHANOPRIVSNEEDED = `:${configuration.ircServer.hostname} 482 ${socket.nickname} #${topicChannelSet} :You're not channel operator (you lack the 'Manage Channel' permission for this channel)\r\n`;
                                        sendToIRC(socket.discordid, ERR_CHANOPRIVSNEEDED, socket.ircid);
                                    }
                                    break;
                                default:
                                    let RPL_NOSUCHCHANNEL = `:${configuration.ircServer.hostname} 403 ${socket.nickname} #${topicChannelLookup} :No such channel\r\n`;
                                    sendToIRC(socket.discordid, RPL_NOSUCHCHANNEL, socket.ircid);
                                    break;
                            }
                            break;
                    case 'MODE':
                        switch(parsedLine.params.length) {
                            case 0:
                                let ERR_NEEDMOREPARAMS = `:${configuration.ircServer.hostname} 461 ${socket.nickname} ${parsedLine.command} :Not enough parameters\r\n`;
                                sendToIRC(socket.discordid, ERR_NEEDMOREPARAMS, socket.ircid);
                                break;
                            case 1:
                                let modeLookupChannel = parsedLine.params[0];
                                //RPL_CHANNELMODEIS (324)
                                //TODO: handle invalid channels, do a check on channel id? crashing now
                                if(modeLookupChannel.startsWith('#')) {
                                    modeLookupChannel = modeLookupChannel.substring(1);
                                    if(ircDetails[socket.discordid].channels[modeLookupChannel].canSetTopic) {
                                        let RPL_CHANNELMODEIS_TOPIC_ON = `:${configuration.ircServer.hostname} 324 ${socket.nickname} #${modeLookupChannel} :+cn\r\n`;
                                        sendToIRC(socket.discordid, RPL_CHANNELMODEIS_TOPIC_ON, socket.ircid);
                                    } else { // can't set topic
                                        let RPL_CHANNELMODEIS_TOPIC_OFF = `:${configuration.ircServer.hostname} 324 ${socket.nickname} #${modeLookupChannel} :+cnt\r\n`;
                                        sendToIRC(socket.discordid, RPL_CHANNELMODEIS_TOPIC_OFF, socket.ircid);
                                    }
                                    } else {//it's a user mode
                                        let RPL_UMODEIS = `:${configuration.ircServer.hostname} 221 ${socket.nickname} :+\r\n`;
                                        sendToIRC(socket.discordid, RPL_UMODEIS, socket.ircid);
                                }
                                    break;
                                case 2:
                                    let modeLookupChannelParam2 = parsedLine.params[0].substring(1);
                                    if(parsedLine.params[1] == '+b') {
                                        //RPL_ENDOFBANLIST (368)
                                        // "<client> <channel> :End of channel ban list"
                                        // static ban list just so it doesn't break things, WONTFIX
                                        let RPL_ENDOFBANLIST = `:${configuration.ircServer.hostname} 368 ${socket.nickname} #${modeLookupChannelParam2} :End of channel ban list\r\n`;
                                        sendToIRC(socket.discordid, RPL_ENDOFBANLIST, socket.ircid);
                                    }
                                    break;
                                }
                                break;
                    case 'WHOIS':
                        const whoisUser = parsedLine.params[0].trim();
                        const userID = ircDetails[socket.discordid].members[whoisUser];
                        break;
                    default: //ERR_UNKNOWNCOMMAND (421)
                        if(parsedLine.command != 'CAP') {//double-check again for CAP here just in case
                            let ERR_UNKNOWNCOMMAND = `:${configuration.ircServer.hostname} 421 ${socket.nickname} ${parsedLine.command} :Unknown command (or not implemented yet)\r\n`;
                            sendToIRC(socket.discordid, ERR_UNKNOWNCOMMAND, socket.ircid);
                        }
                        break;
                }
            }
        });
    });

    ircClients.push(socket);

    // When a client is ended we remove it from the list of clients. 
    socket.on('end', function() {
        ircClients.splice(ircClients.indexOf(socket), 1);

        if (configuration.matchConnectedStatus) {
            if(ircClients == 0) {
                discordClient.user.setStatus('dnd'); // set status to DnD since no clients are connected
            }
        }

    });
});

// Function for sending messages to the connect irc clients 
function sendToIRC(discordServerId, line, ircid = 0) {
    ircClients.forEach(function(socket) {
        if (socket.discordid === discordServerId && socket.authenticated && !socket.isCAPBlocked && (ircid === 0 || ircid === socket.ircid)) {
            socket.write(line);
        }
    });
}

function getSocketDetails(socketID) {
    let socketDetails = {};

    ircClients.forEach(function(socket) {
        if (socket.ircid === socketID) {
            socketDetails = {
                ircid: socket.ircid,
                discordid: socket.discordid,
                nickname: socket.nickname,
                user: socket.user,
                isCAPBlocked: socket.isCAPBlocked,
                authenticated: socket.authenticated,
                awayNotify: socket.awayNotify
            };
        }
    });

    return socketDetails;
}

// Sending notices to all connected clients.
function sendGeneralNotice(noticeText) {
    ircClients.forEach(function(socket) {

        const notice = `:${configuration.ircServer.hostname} NOTICE ${socket.nickname} :${noticeText}\r\n`;
        socket.write(notice);
    });
}

// We want to be able to kill the process without having to deal with leftover connections.
process.on('SIGINT', function() {
    console.log('\nGracefully shutting down from SIGINT (Ctrl-C)');
    sendGeneralNotice('IRC server has been shut down through SIGINT');
    ircClients.forEach(function(socket) {
        socket.end();
    });
    discordClient.destroy();
    ircServer.close();
    process.exit();
});

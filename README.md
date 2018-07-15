# Contributions are very welcome! 

This started out as a personal project when I had a lot of time on my hands a while ago. 
There is still enough room for improvement and I do plan on eventually expanding this and tackling most [issues](https://github.com/creesch/discordIRCd/issues), however since I made this my available free time has been rather limited so I very much do welcome contributions. 

See [CONTRIBUTING.md](https://github.com/creesch/discordIRCd/blob/master/CONTRIBUTING.md) for details. 

# IRC channel

\#discordircd on irc.snoonet.org. 

# discordIRCd
discordIRCd is a node.js application that allows you to connect to discord with your irc client.

![I really like the way I have it set up!](https://imgs.xkcd.com/comics/team_chat.png)  
https://xkcd.com/1782/

# DISCLAIMER 

This is far from complete and only has the most basic IRC functionality in it to make it work with IRCCloud. 
It also has been tested somewhat with Hexchat.

## Usage 

- Run `NPM install`
- Edit config.js to your personal preferences. Your Discord token can be aquired by going into your browsers developer tools and grabbing it from localstorage there. 
- Start the server through server.js 
- Connect with your ircclient to the server at the given adress with the following details: 
    - Username: The username defined in config.js, basically acts as a password. 
    - Server password: The id of the discord server you want to connect to. 
- Join the channels you want.

### Sending and receiving private messages. 
Discord doesn't send private messages based on the server. In order to work around that discordIRCd provides an extra server that is soley used for sending and receiving private messages. To join it it use the server password `DMserver`. 

Private conversations can be initiated from any server but will be automatically taken up by the private message server. 

## Features

- Users joining/leaving channels and servers. 
- Away for idle and dnd discord users. 
- Mentions are translated both ways. 
- Basic discord markdown is parsed to irc formatting. 


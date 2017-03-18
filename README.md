# discordIRCd
Allows you to connect to discord with your irc client.

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

## Features

- Users joining/leaving channels and servers. 
- Away for idle and dnd discord users. 
- Mentions are translated both ways. 
- Basic discord markdown is parsed to irc formatting. 


## TODO: 

- Better authentication. 
- Ton more discord compatibility. 
- Channel topics don't always show up in IRCCloud.
- Joining the same discord server with multiple clients causes some unexpected shared behavior. 

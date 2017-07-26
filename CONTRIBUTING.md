This started out as a personal project when I had a lot of time on my hands a while ago. 
There is still enough room for improvement and I do plan on eventually expanding this and tackling most [issues](https://github.com/creesch/discordIRCd/issues), however since I made this my available free time has been rather limited so I very much do welcome contributions. 

The structure of the project itself is rather simple and I tried to comment as much as possible. Other than that I ask that you follow the below programming style guide. 

### Style Notes:
- Use spaces not tabs.  Tabs will get you killed.  



### Use single quotes for all javascript stuff and double quotes for html in variables. 

Example:

```javascript
     const variable = '<div class="tb-class">content</div>' 
```

### Use template literals for multi-line strings and strings containing variables/expressions 
[MDN page](https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Template_literals)
Examples: 

```javascript
     const multiLine = `string text line 1
                         string text line 2`;

     const expression =`string text ${expression} string text`
```

### Use 'let' or 'const' for variable declarations

  

### Statements longer than one line need to be bracketed. 

Allowed:

```javascript
    if (notEnabled) return;
```

Not allowed:

```javascript
    if (notEnabled)
        return;
```

Bear food:

```javascript
    if (notEnabled)
        return;
    else
        run();
```

If you make it two lines without brackets you **will** be fed to the bear. 

```javascript
    if (notEnabled) return;
    else run();
```
 

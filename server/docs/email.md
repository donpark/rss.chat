# How the server sends email

Sign-in on an rss.chat server is a magic link: the user enters their email address, the server mails them a link, they click it and they're in. There are no passwords. That means your server must be able to send email before anyone -- including you -- can sign in. It's the one piece of the install that depends on something outside the server itself.

There are two ways to send, and one config setting decides between them: if `smtpHost` is present in config.json the server sends through SMTP, otherwise it uses Amazon SES. If you haven't got that working yet and you'd like to look around your server in the meantime, start with the next section.

## Getting in before email works

Setting up mail is the one part of the install that can stall you, and it's a discouraging place to be stopped -- locked out of your own server while you sort out a provider. If the server is running on the machine you're sitting at, you don't have to wait. Type this into your browser, using the name you want and your own email address:

```
http://localhost:1420/localnewuser?screenname=yourname&email=you@example.com
```

The browser lands on your server's home page and you're signed in as that name, ready to post. No email is sent, and nothing has to be configured first.

Four things to know about it:

1. It works only from the machine the server is running on. A request arriving from anywhere else is refused -- including one forwarded by a proxy such as Caddy, nginx or PagePark sitting in front of your server. That's deliberate. The endpoint creates an account without checking that you own the email address, so it must not be reachable from outside.
2. Because of that, it's for a server you can reach by opening a browser on the same machine. On a public server it always refuses, and that refusal is how you can see the protection working.
3. Run it again later with the same name and it signs you back in. It's a way in, not just a way to sign up.
4. If your server is on a port other than 1420, use that port instead.

You still need working email before anyone else can sign in. This gets you in, not them.

Thanks to John Johnston, who hit this after installing rss.chat on his Mac and found the original by-hand version: he read the confirmation code out of the terminal log and typed the sign-in link himself. The server now does that part for you.

## Sending through SMTP

This is the simplest path if you already have an email provider -- most give you SMTP credentials, and services like [Fastmail](https://www.fastmail.com/), [Mailgun](https://www.mailgun.com/), and [SendGrid](https://sendgrid.com/) all work. Add four values at the top level of config.json (not inside the `database` section):

```json
"smtpHost": "smtp.yourprovider.com",
"smtpPort": 587,
"smtpUsername": "you@yourdomain.com",
"smtpPassword": "your-smtp-password",
```

Your provider's docs list the host and port; the username and password are the credentials they gave you. As with any password, keep this config.json out of public repos.

## Sending through Amazon SES

If `smtpHost` is absent, the server sends through [Amazon SES](https://aws.amazon.com/ses/). Nothing goes in config.json for this, but the machine needs AWS credentials (the standard `~/.aws/credentials` file), and your sending address must be verified with SES. Scott Hanson wrote up the whole process for FeedLand, and it applies here unchanged: [How to setup SES](https://github.com/scripting/feedlandInstall/blob/main/docs/setupses.md).

One wall to know about before you hit it: the From address must be at a domain you control and have verified with SES. You can't send from a gmail.com address or any other domain you don't own.

## The email itself

Three settings in config.json shape the confirmation email -- the From address, the subject, and the phrase describing what's being confirmed. They're covered in [config.md](config.md) under Email sign-in. Make sure `mailSender` matches how you're sending: for SMTP it should be an address your provider lets you send from, for SES an address at your verified domain.

Written by Claude Code.

&nbsp;

&nbsp;

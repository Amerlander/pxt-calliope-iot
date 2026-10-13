// Compile check: the extension with the shared types touched once.
const b = new iotcore.Batch()
const c = new iotcore.IngestContext()
iotcore.setWlanSender(function (batch: iotcore.Batch, ctx: iotcore.IngestContext) { return new iotcore.Answer() })
basic.showNumber(b.feeds.length + c.since + (iotcore.wlanSender() ? 1 : 0))

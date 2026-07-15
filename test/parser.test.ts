import { describe, expect, test } from "bun:test";
import { parseUpdate } from "../src/parser.ts";

const noopStore = { parentForMessage: () => null } as any;

describe("parseUpdate", () => {
  test("parses a bot mention", () => {
    const update: any = { update_id:1, message:{ message_id:2, date:1, chat:{id:-100,type:"supergroup"}, from:{id:7,is_bot:false,first_name:"u"}, text:"@SearchBot 查天气", entities:[{type:"mention",offset:0,length:10}] } };
    const result = parseUpdate(update,99,"SearchBot",-100,noopStore);
    expect(result.kind).toBe("request");
    if (result.kind === "request") expect(result.request.question).toBe("查天气");
  });

  test("ignores unmentioned messages", () => {
    const update: any = { update_id:1, message:{ message_id:2, date:1, chat:{id:-100,type:"supergroup"}, from:{id:7,is_bot:false,first_name:"u"}, text:"普通消息" } };
    expect(parseUpdate(update,99,"SearchBot",-100,noopStore).kind).toBe("ignore");
  });

  test("accepts a mention-free follow-up to a known bot answer", () => {
    const store = { parentForMessage: () => ({ id: 42, user_id: 7 }) } as any;
    const update: any = { update_id:2, message:{ message_id:3, date:1, chat:{id:-100,type:"supergroup"}, from:{id:7,is_bot:false,first_name:"u"}, text:"那国内呢？", reply_to_message:{message_id:2,date:1,chat:{id:-100,type:"supergroup"},from:{id:99,is_bot:true,first_name:"bot"},text:"answer"} } };
    const result = parseUpdate(update,99,"SearchBot",-100,store);
    expect(result.kind).toBe("request");
    if (result.kind === "request") expect(result.request.parentNodeId).toBe(42);
  });

  test("does not inherit another user's reply chain", () => {
    const store = { parentForMessage: () => ({ id: 42, user_id: 8 }) } as any;
    const update: any = { update_id:4, message:{ message_id:5, date:1, chat:{id:-100,type:"supergroup"}, from:{id:7,is_bot:false,first_name:"u"}, text:"@SearchBot 独立回答这个问题", entities:[{type:"mention",offset:0,length:10}], reply_to_message:{message_id:2,date:1,chat:{id:-100,type:"supergroup"},from:{id:99,is_bot:true,first_name:"bot"},text:"answer"} } };
    const result = parseUpdate(update,99,"SearchBot",-100,store);
    expect(result.kind).toBe("request");
    if (result.kind === "request") expect(result.request.parentNodeId).toBeUndefined();
  });

  test("includes an image from a quoted user message", () => {
    const update: any = { update_id:3, message:{ message_id:4, date:1, chat:{id:-100,type:"supergroup"}, from:{id:7,is_bot:false,first_name:"u"}, text:"@SearchBot 这是什么？", entities:[{type:"mention",offset:0,length:10}], reply_to_message:{message_id:3,date:1,chat:{id:-100,type:"supergroup"},from:{id:8,is_bot:false,first_name:"v"},photo:[{file_id:"f",file_unique_id:"u",width:100,height:100,file_size:10}]} } };
    const result = parseUpdate(update,99,"SearchBot",-100,noopStore);
    expect(result.kind).toBe("request");
    if (result.kind === "request") expect(result.request.imageRefs[0]?.origin).toBe("quoted");
  });
});

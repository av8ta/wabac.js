import { rewriteDASH } from './rewriteVideo';


// ===========================================================================
const DEFAULT_RULES = [
  {
    contains: "youtube.com",
    rxRules: [
      [/ytplayer.load\(\);/, ruleReplace('ytplayer.config.args.dash = "0"; ytplayer.config.args.dashmpd = ""; {0}')],
      [/yt\.setConfig.*PLAYER_CONFIG.*args":\s*{/, ruleReplace('{0} "dash": "0", dashmpd: "", ')],
      [/"player":.*"args":{/, ruleReplace('{0}"dash":"0","dashmpd":"",')],
    ]
  },
  {
    contains: "vimeo.com/video",
    rxRules: [
      [/\"dash\"[:]/, ruleReplace('"__dash":')],
      [/\"hls\"[:]/, ruleReplace('"__hls":')],
    ]
  },
  {
    contains: "facebook.com/",
    rxRules: [
      [/"dash_manifest":"?.*dash_prefetched_representation_ids"?:.*?\]/, ruleRewriteFBDash],
    ]
  }
];


// ===========================================================================
function ruleReplace(string) {
  return x => string.replace('{0}', x); 
}


// ===========================================================================
function ruleRewriteFBDash(string) {
  let dashManifest = null;

  console.log("FB Dash");

  try {
    dashManifest = JSON.parse(string.match(/dash_manifest":(".*"),"dash/)[1]);
  } catch (e) {
    console.log(e);
    return;
  }

  let bestIds = [];

  const newDashManifest = rewriteDASH(dashManifest, bestIds) + "\n";

  const resultJSON = {"dash_manifest": newDashManifest, "dash_prefetched_representation_ids": bestIds};   

  const result = JSON.stringify(resultJSON).replace(/</g, "\\u003C").slice(1, -1);

  return result;
}

// ===========================================================================
class DomainSpecificRuleSet
{

  constructor(RewriterCls, rwRules) {
    this.rwRules = rwRules || DEFAULT_RULES;
    this.RewriterCls = RewriterCls;

    this._initRules();
  }

  _initRules() {
    for (let rule of this.rwRules) {
      if (rule.rxRules) {
        rule.rxRewriter = new this.RewriterCls(rule.rxRules);
      }
    }
    this.defaultRewriter = new this.RewriterCls();
  }

  getRewriter(url) {
    for (let rule of this.rwRules) {
      if (rule.contains && url.indexOf(rule.contains) >= 0) {
        if (rule.rxRewriter) {
          console.log(rule.contains);
          console.log("Custom RW");
          return rule.rxRewriter;
        }
      }
    }

    return this.defaultRewriter;
  }
}

export { DomainSpecificRuleSet };


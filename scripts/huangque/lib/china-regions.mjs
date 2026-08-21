/**
 * Deterministic China work-location normalizer.
 *
 * The engine intentionally stops at the province/prefecture level. Province
 * and prefecture codes follow the six-digit administrative-division code
 * convention. Municipalities are displayed as a single level (for example
 * `北京`), while ordinary cities are displayed as `湖北省-武汉市`.
 */

const DATA_VERSION = "2025-12-31";

const rows = [
  ["110000", "北京", "北京市", "北京|Beijing", []],
  ["120000", "天津", "天津市", "天津|Tianjin", []],
  ["130000", "河北省", "河北省", "河北|Hebei", [
    ["130100", "石家庄市", "石家庄|Shijiazhuang"], ["130200", "唐山市", "唐山|Tangshan"], ["130300", "秦皇岛市", "秦皇岛|Qinhuangdao"], ["130400", "邯郸市", "邯郸|Handan"], ["130500", "邢台市", "邢台|Xingtai"], ["130600", "保定市", "保定|Baoding"], ["130700", "张家口市", "张家口|Zhangjiakou"], ["130800", "承德市", "承德|Chengde"], ["130900", "沧州市", "沧州|Cangzhou"], ["131000", "廊坊市", "廊坊|Langfang"], ["131100", "衡水市", "衡水|Hengshui"],
  ]],
  ["140000", "山西省", "山西省", "山西|Shanxi", [
    ["140100", "太原市", "太原|Taiyuan"], ["140200", "大同市", "大同|Datong"], ["140300", "阳泉市", "阳泉|Yangquan"], ["140400", "长治市", "长治|Changzhi"], ["140500", "晋城市", "晋城|Jincheng"], ["140600", "朔州市", "朔州|Shuozhou"], ["140700", "晋中市", "晋中|Jinzhong"], ["140800", "运城市", "运城|Yuncheng"], ["140900", "忻州市", "忻州|Xinzhou"], ["141000", "临汾市", "临汾|Linfen"], ["141100", "吕梁市", "吕梁|Lvliang|Luliang"],
  ]],
  ["150000", "内蒙古自治区", "内蒙古自治区", "内蒙古|Inner Mongolia", [
    ["150100", "呼和浩特市", "呼和浩特|Hohhot"], ["150200", "包头市", "包头|Baotou"], ["150300", "乌海市", "乌海|Wuhai"], ["150400", "赤峰市", "赤峰|Chifeng"], ["150500", "通辽市", "通辽|Tongliao"], ["150600", "鄂尔多斯市", "鄂尔多斯|Ordos"], ["150700", "呼伦贝尔市", "呼伦贝尔|Hulunbuir"], ["150800", "巴彦淖尔市", "巴彦淖尔|Bayannur"], ["150900", "乌兰察布市", "乌兰察布|Ulanqab"], ["152200", "兴安盟", "兴安盟|Hinggan"], ["152500", "锡林郭勒盟", "锡林郭勒|Xilingol"], ["152900", "阿拉善盟", "阿拉善|Alxa"],
  ]],
  ["210000", "辽宁省", "辽宁省", "辽宁|Liaoning", [
    ["210100", "沈阳市", "沈阳|Shenyang"], ["210200", "大连市", "大连|Dalian"], ["210300", "鞍山市", "鞍山|Anshan"], ["210400", "抚顺市", "抚顺|Fushun"], ["210500", "本溪市", "本溪|Benxi"], ["210600", "丹东市", "丹东|Dandong"], ["210700", "锦州市", "锦州|Jinzhou"], ["210800", "营口市", "营口|Yingkou"], ["210900", "阜新市", "阜新|Fuxin"], ["211000", "辽阳市", "辽阳|Liaoyang"], ["211100", "盘锦市", "盘锦|Panjin"], ["211200", "铁岭市", "铁岭|Tieling"], ["211300", "朝阳市", "朝阳|Chaoyang"], ["211400", "葫芦岛市", "葫芦岛|Huludao"],
  ]],
  ["220000", "吉林省", "吉林省", "吉林省|Jilin Province", [
    ["220100", "长春市", "长春|Changchun"], ["220200", "吉林市", "吉林市|Jilin City"], ["220300", "四平市", "四平|Siping"], ["220400", "辽源市", "辽源|Liaoyuan"], ["220500", "通化市", "通化|Tonghua"], ["220600", "白山市", "白山|Baishan"], ["220700", "松原市", "松原|Songyuan"], ["220800", "白城市", "白城|Baicheng"], ["222400", "延边朝鲜族自治州", "延边|Yanbian"],
  ]],
  ["230000", "黑龙江省", "黑龙江省", "黑龙江|Heilongjiang", [
    ["230100", "哈尔滨市", "哈尔滨|Harbin"], ["230200", "齐齐哈尔市", "齐齐哈尔|Qiqihar"], ["230300", "鸡西市", "鸡西|Jixi"], ["230400", "鹤岗市", "鹤岗|Hegang"], ["230500", "双鸭山市", "双鸭山|Shuangyashan"], ["230600", "大庆市", "大庆|Daqing"], ["230700", "伊春市", "伊春|Yichun"], ["230800", "佳木斯市", "佳木斯|Jiamusi"], ["230900", "七台河市", "七台河|Qitaihe"], ["231000", "牡丹江市", "牡丹江|Mudanjiang"], ["231100", "黑河市", "黑河|Heihe"], ["231200", "绥化市", "绥化|Suihua"], ["232700", "大兴安岭地区", "大兴安岭|Greater Khingan"],
  ]],
  ["310000", "上海", "上海市", "上海|Shanghai", []],
  ["320000", "江苏省", "江苏省", "江苏|Jiangsu", [
    ["320100", "南京市", "南京|Nanjing"], ["320200", "无锡市", "无锡|Wuxi"], ["320300", "徐州市", "徐州|Xuzhou"], ["320400", "常州市", "常州|Changzhou"], ["320500", "苏州市", "苏州|Suzhou"], ["320600", "南通市", "南通|Nantong"], ["320700", "连云港市", "连云港|Lianyungang"], ["320800", "淮安市", "淮安|Huai'an|Huaian"], ["320900", "盐城市", "盐城|Yancheng"], ["321000", "扬州市", "扬州|Yangzhou"], ["321100", "镇江市", "镇江|Zhenjiang"], ["321200", "泰州市", "泰州|Taizhou"], ["321300", "宿迁市", "宿迁|Suqian"],
  ]],
  ["330000", "浙江省", "浙江省", "浙江|Zhejiang", [
    ["330100", "杭州市", "杭州|Hangzhou"], ["330200", "宁波市", "宁波|Ningbo"], ["330300", "温州市", "温州|Wenzhou"], ["330400", "嘉兴市", "嘉兴|Jiaxing"], ["330500", "湖州市", "湖州|Huzhou"], ["330600", "绍兴市", "绍兴|Shaoxing"], ["330700", "金华市", "金华|Jinhua"], ["330800", "衢州市", "衢州|Quzhou"], ["330900", "舟山市", "舟山|Zhoushan"], ["331000", "台州市", "台州|Taizhou"], ["331100", "丽水市", "丽水|Lishui"],
  ]],
  ["340000", "安徽省", "安徽省", "安徽|Anhui", [
    ["340100", "合肥市", "合肥|Hefei"], ["340200", "芜湖市", "芜湖|Wuhu"], ["340300", "蚌埠市", "蚌埠|Bengbu"], ["340400", "淮南市", "淮南|Huainan"], ["340500", "马鞍山市", "马鞍山|Ma'anshan|Maanshan"], ["340600", "淮北市", "淮北|Huaibei"], ["340700", "铜陵市", "铜陵|Tongling"], ["340800", "安庆市", "安庆|Anqing"], ["341000", "黄山市", "黄山|Huangshan"], ["341100", "滁州市", "滁州|Chuzhou"], ["341200", "阜阳市", "阜阳|Fuyang"], ["341300", "宿州市", "宿州|Suzhou"], ["341500", "六安市", "六安|Lu'an|Luan"], ["341600", "亳州市", "亳州|Bozhou"], ["341700", "池州市", "池州|Chizhou"], ["341800", "宣城市", "宣城|Xuancheng"],
  ]],
  ["350000", "福建省", "福建省", "福建|Fujian", [
    ["350100", "福州市", "福州|Fuzhou"], ["350200", "厦门市", "厦门|Xiamen"], ["350300", "莆田市", "莆田|Putian"], ["350400", "三明市", "三明|Sanming"], ["350500", "泉州市", "泉州|Quanzhou"], ["350600", "漳州市", "漳州|Zhangzhou"], ["350700", "南平市", "南平|Nanping"], ["350800", "龙岩市", "龙岩|Longyan"], ["350900", "宁德市", "宁德|Ningde"],
  ]],
  ["360000", "江西省", "江西省", "江西|Jiangxi", [
    ["360100", "南昌市", "南昌|Nanchang"], ["360200", "景德镇市", "景德镇|Jingdezhen"], ["360300", "萍乡市", "萍乡|Pingxiang"], ["360400", "九江市", "九江|Jiujiang"], ["360500", "新余市", "新余|Xinyu"], ["360600", "鹰潭市", "鹰潭|Yingtan"], ["360700", "赣州市", "赣州|Ganzhou"], ["360800", "吉安市", "吉安|Ji'an|Jian"], ["360900", "宜春市", "宜春|Yichun"], ["361000", "抚州市", "抚州|Fuzhou"], ["361100", "上饶市", "上饶|Shangrao"],
  ]],
  ["370000", "山东省", "山东省", "山东|Shandong", [
    ["370100", "济南市", "济南|Jinan"], ["370200", "青岛市", "青岛|Qingdao|Tsingtao"], ["370300", "淄博市", "淄博|Zibo"], ["370400", "枣庄市", "枣庄|Zaozhuang"], ["370500", "东营市", "东营|Dongying"], ["370600", "烟台市", "烟台|Yantai"], ["370700", "潍坊市", "潍坊|Weifang"], ["370800", "济宁市", "济宁|Jining"], ["370900", "泰安市", "泰安|Tai'an|Taian"], ["371000", "威海市", "威海|Weihai"], ["371100", "日照市", "日照|Rizhao"], ["371300", "临沂市", "临沂|Linyi"], ["371400", "德州市", "德州|Dezhou"], ["371500", "聊城市", "聊城|Liaocheng"], ["371600", "滨州市", "滨州|Binzhou"], ["371700", "菏泽市", "菏泽|Heze"],
  ]],
  ["410000", "河南省", "河南省", "河南|Henan", [
    ["410100", "郑州市", "郑州|Zhengzhou"], ["410200", "开封市", "开封|Kaifeng"], ["410300", "洛阳市", "洛阳|Luoyang"], ["410400", "平顶山市", "平顶山|Pingdingshan"], ["410500", "安阳市", "安阳|Anyang"], ["410600", "鹤壁市", "鹤壁|Hebi"], ["410700", "新乡市", "新乡|Xinxiang"], ["410800", "焦作市", "焦作|Jiaozuo"], ["410900", "濮阳市", "濮阳|Puyang"], ["411000", "许昌市", "许昌|Xuchang"], ["411100", "漯河市", "漯河|Luohe"], ["411200", "三门峡市", "三门峡|Sanmenxia"], ["411300", "南阳市", "南阳|Nanyang"], ["411400", "商丘市", "商丘|Shangqiu"], ["411500", "信阳市", "信阳|Xinyang"], ["411600", "周口市", "周口|Zhoukou"], ["411700", "驻马店市", "驻马店|Zhumadian"], ["419001", "济源市", "济源|Jiyuan"],
  ]],
  ["420000", "湖北省", "湖北省", "湖北|Hubei", [
    ["420100", "武汉市", "武汉|Wuhan"], ["420200", "黄石市", "黄石|Huangshi"], ["420300", "十堰市", "十堰|Shiyan"], ["420500", "宜昌市", "宜昌|Yichang"], ["420600", "襄阳市", "襄阳|Xiangyang"], ["420700", "鄂州市", "鄂州|Ezhou"], ["420800", "荆门市", "荆门|Jingmen"], ["420900", "孝感市", "孝感|Xiaogan"], ["421000", "荆州市", "荆州|Jingzhou"], ["421100", "黄冈市", "黄冈|Huanggang"], ["421200", "咸宁市", "咸宁|Xianning"], ["421300", "随州市", "随州|Suizhou"], ["422800", "恩施土家族苗族自治州", "恩施|Enshi"], ["429004", "仙桃市", "仙桃|Xiantao"], ["429005", "潜江市", "潜江|Qianjiang"], ["429006", "天门市", "天门|Tianmen"], ["429021", "神农架林区", "神农架|Shennongjia"],
  ]],
  ["430000", "湖南省", "湖南省", "湖南|Hunan", [
    ["430100", "长沙市", "长沙|Changsha"], ["430200", "株洲市", "株洲|Zhuzhou"], ["430300", "湘潭市", "湘潭|Xiangtan"], ["430400", "衡阳市", "衡阳|Hengyang"], ["430500", "邵阳市", "邵阳|Shaoyang"], ["430600", "岳阳市", "岳阳|Yueyang"], ["430700", "常德市", "常德|Changde"], ["430800", "张家界市", "张家界|Zhangjiajie"], ["430900", "益阳市", "益阳|Yiyang"], ["431000", "郴州市", "郴州|Chenzhou"], ["431100", "永州市", "永州|Yongzhou"], ["431200", "怀化市", "怀化|Huaihua"], ["431300", "娄底市", "娄底|Loudi"], ["433100", "湘西土家族苗族自治州", "湘西|Xiangxi"],
  ]],
  ["440000", "广东省", "广东省", "广东|Guangdong|Canton", [
    ["440100", "广州市", "广州|Guangzhou|Canton"], ["440200", "韶关市", "韶关|Shaoguan"], ["440300", "深圳市", "深圳|Shenzhen"], ["440400", "珠海市", "珠海|Zhuhai"], ["440500", "汕头市", "汕头|Shantou"], ["440600", "佛山市", "佛山|Foshan"], ["440700", "江门市", "江门|Jiangmen"], ["440800", "湛江市", "湛江|Zhanjiang"], ["440900", "茂名市", "茂名|Maoming"], ["441200", "肇庆市", "肇庆|Zhaoqing"], ["441300", "惠州市", "惠州|Huizhou"], ["441400", "梅州市", "梅州|Meizhou"], ["441500", "汕尾市", "汕尾|Shanwei"], ["441600", "河源市", "河源|Heyuan"], ["441700", "阳江市", "阳江|Yangjiang"], ["441800", "清远市", "清远|Qingyuan"], ["441900", "东莞市", "东莞|Dongguan"], ["442000", "中山市", "中山|Zhongshan"], ["445100", "潮州市", "潮州|Chaozhou"], ["445200", "揭阳市", "揭阳|Jieyang"], ["445300", "云浮市", "云浮|Yunfu"],
  ]],
  ["450000", "广西壮族自治区", "广西壮族自治区", "广西|Guangxi", [
    ["450100", "南宁市", "南宁|Nanning"], ["450200", "柳州市", "柳州|Liuzhou"], ["450300", "桂林市", "桂林|Guilin"], ["450400", "梧州市", "梧州|Wuzhou"], ["450500", "北海市", "北海|Beihai"], ["450600", "防城港市", "防城港|Fangchenggang"], ["450700", "钦州市", "钦州|Qinzhou"], ["450800", "贵港市", "贵港|Guigang"], ["450900", "玉林市", "玉林|Yulin"], ["451000", "百色市", "百色|Baise"], ["451100", "贺州市", "贺州|Hezhou"], ["451200", "河池市", "河池|Hechi"], ["451300", "来宾市", "来宾|Laibin"], ["451400", "崇左市", "崇左|Chongzuo"],
  ]],
  ["460000", "海南省", "海南省", "海南省|Hainan Province|Hainan, China", [
    ["460100", "海口市", "海口|Haikou"], ["460200", "三亚市", "三亚|Sanya"], ["460300", "三沙市", "三沙|Sansha"], ["460400", "儋州市", "儋州|Danzhou"],
    ["469001", "五指山市", "五指山|Wuzhishan"], ["469002", "琼海市", "琼海|Qionghai"], ["469005", "文昌市", "文昌|Wenchang"], ["469006", "万宁市", "万宁|Wanning"], ["469007", "东方市", "东方市|Dongfang"],
    ["469021", "定安县", "定安|Ding'an|Dingan"], ["469022", "屯昌县", "屯昌|Tunchang"], ["469023", "澄迈县", "澄迈|Chengmai"], ["469024", "临高县", "临高|Lingao"], ["469025", "白沙黎族自治县", "白沙|Baisha"],
    ["469026", "昌江黎族自治县", "昌江|Changjiang"], ["469027", "乐东黎族自治县", "乐东|Ledong"], ["469028", "陵水黎族自治县", "陵水|Lingshui"], ["469029", "保亭黎族苗族自治县", "保亭|Baoting"], ["469030", "琼中黎族苗族自治县", "琼中|Qiongzhong"],
  ]],
  ["500000", "重庆", "重庆市", "重庆|Chongqing", []],
  ["510000", "四川省", "四川省", "四川|Sichuan", [
    ["510100", "成都市", "成都|Chengdu"], ["510300", "自贡市", "自贡|Zigong"], ["510400", "攀枝花市", "攀枝花|Panzhihua"], ["510500", "泸州市", "泸州|Luzhou"], ["510600", "德阳市", "德阳|Deyang"], ["510700", "绵阳市", "绵阳|Mianyang"], ["510800", "广元市", "广元|Guangyuan"], ["510900", "遂宁市", "遂宁|Suining"], ["511000", "内江市", "内江|Neijiang"], ["511100", "乐山市", "乐山|Leshan"], ["511300", "南充市", "南充|Nanchong"], ["511400", "眉山市", "眉山|Meishan"], ["511500", "宜宾市", "宜宾|Yibin"], ["511600", "广安市", "广安|Guang'an|Guangan"], ["511700", "达州市", "达州|Dazhou"], ["511800", "雅安市", "雅安|Ya'an|Yaan"], ["511900", "巴中市", "巴中|Bazhong"], ["512000", "资阳市", "资阳|Ziyang"], ["513200", "阿坝藏族羌族自治州", "阿坝|Aba"], ["513300", "甘孜藏族自治州", "甘孜|Garze|Ganzi"], ["513400", "凉山彝族自治州", "凉山|Liangshan"],
  ]],
  ["520000", "贵州省", "贵州省", "贵州|Guizhou", [
    ["520100", "贵阳市", "贵阳|Guiyang"], ["520200", "六盘水市", "六盘水|Liupanshui"], ["520300", "遵义市", "遵义|Zunyi"], ["520400", "安顺市", "安顺|Anshun"], ["520500", "毕节市", "毕节|Bijie"], ["520600", "铜仁市", "铜仁|Tongren"], ["522300", "黔西南布依族苗族自治州", "黔西南|Qianxinan"], ["522600", "黔东南苗族侗族自治州", "黔东南|Qiandongnan"], ["522700", "黔南布依族苗族自治州", "黔南|Qiannan"],
  ]],
  ["530000", "云南省", "云南省", "云南|Yunnan", [
    ["530100", "昆明市", "昆明|Kunming"], ["530300", "曲靖市", "曲靖|Qujing"], ["530400", "玉溪市", "玉溪|Yuxi"], ["530500", "保山市", "保山|Baoshan"], ["530600", "昭通市", "昭通|Zhaotong"], ["530700", "丽江市", "丽江|Lijiang"], ["530800", "普洱市", "普洱|Pu'er|Puer"], ["530900", "临沧市", "临沧|Lincang"], ["532300", "楚雄彝族自治州", "楚雄|Chuxiong"], ["532500", "红河哈尼族彝族自治州", "红河|Honghe"], ["532600", "文山壮族苗族自治州", "文山|Wenshan"], ["532800", "西双版纳傣族自治州", "西双版纳|Xishuangbanna"], ["532900", "大理白族自治州", "大理|Dali"], ["533100", "德宏傣族景颇族自治州", "德宏|Dehong"], ["533300", "怒江傈僳族自治州", "怒江|Nujiang"], ["533400", "迪庆藏族自治州", "迪庆|Diqing"],
  ]],
  ["540000", "西藏自治区", "西藏自治区", "西藏|Tibet|Xizang", [
    ["540100", "拉萨市", "拉萨|Lhasa"], ["540200", "日喀则市", "日喀则|Shigatse"], ["540300", "昌都市", "昌都|Chamdo"], ["540400", "林芝市", "林芝|Nyingchi"], ["540500", "山南市", "山南|Shannan"], ["540600", "那曲市", "那曲|Nagqu"], ["542500", "阿里地区", "阿里地区|Ngari"],
  ]],
  ["610000", "陕西省", "陕西省", "陕西|Shaanxi", [
    ["610100", "西安市", "西安|Xi'an|Xian"], ["610200", "铜川市", "铜川|Tongchuan"], ["610300", "宝鸡市", "宝鸡|Baoji"], ["610400", "咸阳市", "咸阳|Xianyang"], ["610500", "渭南市", "渭南|Weinan"], ["610600", "延安市", "延安|Yan'an|Yanan"], ["610700", "汉中市", "汉中|Hanzhong"], ["610800", "榆林市", "榆林|Yulin"], ["610900", "安康市", "安康|Ankang"], ["611000", "商洛市", "商洛|Shangluo"],
  ]],
  ["620000", "甘肃省", "甘肃省", "甘肃|Gansu", [
    ["620100", "兰州市", "兰州|Lanzhou"], ["620200", "嘉峪关市", "嘉峪关|Jiayuguan"], ["620300", "金昌市", "金昌|Jinchang"], ["620400", "白银市", "白银|Baiyin"], ["620500", "天水市", "天水|Tianshui"], ["620600", "武威市", "武威|Wuwei"], ["620700", "张掖市", "张掖|Zhangye"], ["620800", "平凉市", "平凉|Pingliang"], ["620900", "酒泉市", "酒泉|Jiuquan"], ["621000", "庆阳市", "庆阳|Qingyang"], ["621100", "定西市", "定西|Dingxi"], ["621200", "陇南市", "陇南|Longnan"], ["622900", "临夏回族自治州", "临夏|Linxia"], ["623000", "甘南藏族自治州", "甘南|Gannan"],
  ]],
  ["630000", "青海省", "青海省", "青海|Qinghai", [
    ["630100", "西宁市", "西宁|Xining"], ["630200", "海东市", "海东|Haidong"], ["632200", "海北藏族自治州", "海北|Haibei"], ["632300", "黄南藏族自治州", "黄南|Huangnan"], ["632500", "海南藏族自治州", "海南州|Hainan Prefecture"], ["632600", "果洛藏族自治州", "果洛|Golog|Guoluo"], ["632700", "玉树藏族自治州", "玉树|Yushu"], ["632800", "海西蒙古族藏族自治州", "海西|Haixi"],
  ]],
  ["640000", "宁夏回族自治区", "宁夏回族自治区", "宁夏|Ningxia", [
    ["640100", "银川市", "银川|Yinchuan"], ["640200", "石嘴山市", "石嘴山|Shizuishan"], ["640300", "吴忠市", "吴忠|Wuzhong"], ["640400", "固原市", "固原|Guyuan"], ["640500", "中卫市", "中卫|Zhongwei"],
  ]],
  ["650000", "新疆维吾尔自治区", "新疆维吾尔自治区", "新疆|Xinjiang", [
    ["650100", "乌鲁木齐市", "乌鲁木齐|Urumqi"], ["650200", "克拉玛依市", "克拉玛依|Karamay"], ["650400", "吐鲁番市", "吐鲁番|Turpan"], ["650500", "哈密市", "哈密|Hami"], ["652300", "昌吉回族自治州", "昌吉|Changji"], ["652700", "博尔塔拉蒙古自治州", "博尔塔拉|Bortala"], ["652800", "巴音郭楞蒙古自治州", "巴音郭楞|Bayingolin"], ["652900", "阿克苏地区", "阿克苏|Aksu"], ["653000", "克孜勒苏柯尔克孜自治州", "克孜勒苏|Kizilsu"], ["653100", "喀什地区", "喀什|Kashgar"], ["653200", "和田地区", "和田|Hotan"], ["654000", "伊犁哈萨克自治州", "伊犁|Ili"], ["654200", "塔城地区", "塔城|Tacheng"], ["654300", "阿勒泰地区", "阿勒泰|Altay"], ["659001", "石河子市", "石河子|Shihezi"], ["659002", "阿拉尔市", "阿拉尔|Aral"], ["659003", "图木舒克市", "图木舒克|Tumxuk"], ["659004", "五家渠市", "五家渠|Wujiaqu"], ["659005", "北屯市", "北屯|Beitun"], ["659006", "铁门关市", "铁门关|Tiemenguan"], ["659007", "双河市", "双河|Shuanghe"], ["659008", "可克达拉市", "可克达拉|Kokdala"], ["659009", "昆玉市", "昆玉|Kunyu"], ["659010", "胡杨河市", "胡杨河|Huyanghe"], ["659011", "新星市", "新星|Xinxing"], ["659012", "白杨市", "白杨|Baiyang"],
  ]],
  ["710000", "台湾省", "台湾省", "台湾|Taiwan", []],
  ["810000", "香港特别行政区", "香港特别行政区", "香港|Hong Kong|Hongkong", []],
  ["820000", "澳门特别行政区", "澳门特别行政区", "澳门|Macao|Macau", []],
];

function aliases(pattern) {
  return String(pattern || "").split("|").map((item) => item.trim()).filter(Boolean);
}

function normalizedForMatch(value) {
  return String(value || "").normalize("NFKC").replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
}

function aliasMatch(text, alias) {
  if (!alias) return false;
  if (/^[\p{ASCII}]+$/u.test(alias)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`, "i").test(text);
  }
  return text.includes(alias);
}

export const CHINA_REGIONS = Object.freeze(rows.map(([provinceCode, label, provinceName, provinceAliases, cities]) => Object.freeze({
  provinceCode,
  provinceName,
  label,
  aliases: aliases(provinceAliases),
  municipality: ["110000", "120000", "310000", "500000"].includes(provinceCode),
  cities: Object.freeze(cities.map(([cityCode, cityName, cityAliases]) => Object.freeze({ cityCode, cityName, aliases: aliases(cityAliases) }))),
})));

export const CHINA_REGION_DATA_VERSION = DATA_VERSION;

const cityIndex = CHINA_REGIONS.flatMap((province) => province.cities.map((city) => ({ province, city })));
const foreignSignals = /\b(?:Japan|Tokyo|Osaka|Singapore|United States|USA|Canada|Australia|India|Korea|Vietnam|Thailand|Indonesia|Malaysia|Philippines|Germany|France|United Kingdom|UK|London|New York|Seattle|San Francisco|Amsterdam|Berlin|Paris)\b|日本|东京|大阪|新加坡|美国|加拿大|澳大利亚|印度|韩国|越南|泰国|印度尼西亚|马来西亚|菲律宾|德国|法国|英国/i;
const chinaSignals = /中国|全国|大陆|内地|China|Mainland/i;
const remoteSignals = /远程|居家|remote|work\s*from\s*home|wfh/i;

function regionRecord(province, city = null, { confidence = 1, basis = "explicit_location", remote = false } = {}) {
  const label = province.municipality
    ? province.label
    : city
      ? `${province.label}-${city.cityName}`
      : province.label;
  return {
    countryCode: "CN",
    provinceCode: province.provinceCode,
    provinceName: province.provinceName,
    cityCode: city?.cityCode || null,
    cityName: city?.cityName || null,
    label,
    remote,
    confidence,
    basis,
  };
}

function nationalRecord({ remote = false, confidence = 0.9, basis = "explicit_location" } = {}) {
  return {
    countryCode: "CN",
    provinceCode: null,
    provinceName: null,
    cityCode: null,
    cityName: null,
    label: remote ? "全国-远程" : "全国",
    remote,
    confidence,
    basis,
  };
}

function ambiguousChinaRecord() {
  return {
    countryCode: "CN",
    provinceCode: null,
    provinceName: null,
    cityCode: null,
    cityName: null,
    label: "中国-地点待核验",
    remote: false,
    confidence: 0.35,
    basis: "ambiguous_city_needs_review",
  };
}

function uniqueRegions(items) {
  const deduplicated = [...new Map(items.map((item) => [`${item.provinceCode || "CN"}:${item.cityCode || "ALL"}:${item.remote ? "R" : "O"}`, item])).values()];
  const hasSpecificRegion = deduplicated.some((item) => item.provinceCode);
  const provincesWithCity = new Set(deduplicated.filter((item) => item.cityCode).map((item) => item.provinceCode));
  return deduplicated.filter((item) => {
    if (!item.provinceCode) return item.remote || !hasSpecificRegion;
    if (!item.cityCode && provincesWithCity.has(item.provinceCode)) return false;
    return true;
  });
}

export function classifyChinaLocation(value, options = {}) {
  const text = normalizedForMatch(value);
  if (!text) return { status: "unknown", raw: text, regions: [] };
  const provinceHints = CHINA_REGIONS.filter((province) => province.aliases.some((alias) => aliasMatch(text, alias)));
  const matches = [];
  for (const { province, city } of cityIndex) {
    if (provinceHints.length && !provinceHints.includes(province)) continue;
    if (city.aliases.some((alias) => aliasMatch(text, alias))) matches.push(regionRecord(province, city, options));
  }
  const matchedProvinces = new Set(matches.map((item) => item.provinceCode));
  if (!provinceHints.length && matchedProvinces.size > 1) {
    return {
      status: "china",
      raw: text,
      regions: [ambiguousChinaRecord()],
      ambiguousRegions: uniqueRegions(matches).map((region) => ({ ...region, confidence: 0.35, basis: "ambiguous_city_candidate" })),
    };
  }
  for (const province of CHINA_REGIONS) {
    if (matches.some((item) => item.provinceCode === province.provinceCode)) continue;
    if (province.aliases.some((alias) => aliasMatch(text, alias))) matches.push(regionRecord(province, null, options));
  }
  if (matches.length) return { status: "china", raw: text, regions: uniqueRegions(matches) };
  if (remoteSignals.test(text) && chinaSignals.test(text)) return { status: "china", raw: text, regions: [nationalRecord({ ...options, remote: true })] };
  if (chinaSignals.test(text)) return { status: "china", raw: text, regions: [nationalRecord(options)] };
  if (foreignSignals.test(text)) return { status: "outside_china", raw: text, regions: [] };
  return { status: "unknown", raw: text, regions: [] };
}

function flattenLocationValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(flattenLocationValues);
  if (typeof value === "object") {
    return [
      value.name,
      value.location,
      value.addressLocality,
      value.addressRegion,
      value.addressCountry,
      value.address?.addressLocality,
      value.address?.addressRegion,
      value.address?.addressCountry,
      value.postalAddress?.addressLocality,
      value.postalAddress?.addressRegion,
      value.postalAddress?.addressCountry,
    ].flatMap(flattenLocationValues);
  }
  const text = normalizedForMatch(value);
  if (!text) return [];
  return text.split(/\s*(?:;|；|、|\||\n|\/)\s*/).filter(Boolean);
}

export function classifyChinaLocations(value, options = {}) {
  const values = flattenLocationValues(value);
  const classified = values.map((item) => classifyChinaLocation(item, options));
  const regions = uniqueRegions(classified.flatMap((item) => item.regions));
  return {
    status: regions.length ? "china" : classified.some((item) => item.status === "outside_china") ? "outside_china" : "unknown",
    rawValues: values,
    regions,
    outsideChinaValues: classified.filter((item) => item.status === "outside_china").map((item) => item.raw),
    unknownValues: classified.filter((item) => item.status === "unknown").map((item) => item.raw),
    ambiguousRegions: uniqueRegions(classified.flatMap((item) => item.ambiguousRegions || [])),
  };
}

export function extractChinaRegionSignals(value) {
  return classifyChinaLocations(value, { confidence: 0.8, basis: "discovery_text" }).regions;
}

export function structuredJobLocationValues(row) {
  if (!row || typeof row !== "object") return [];
  return flattenLocationValues([
    row.workLocationsRaw,
    row.workLocations,
    row.location,
    row.locations,
    row.secondaryLocations,
    row.jobLocation,
    row.categories?.location,
    row.areaName,
    row.city,
    row.address,
    row.gzdd,
  ]);
}

export function rowLocatedInChina(row, { authoritativeRegions = [] } = {}) {
  const classified = classifyChinaLocations(structuredJobLocationValues(row));
  if (classified.status === "china") return true;
  return classified.status === "unknown" && authoritativeRegions.length > 0;
}

export function normalizeJobRegions(raw, source = null) {
  const explicit = classifyChinaLocations(structuredJobLocationValues(raw));
  if (explicit.regions.length) {
    const onlyGenericNational = explicit.regions.every((region) => !region.provinceCode && !region.remote);
    if (onlyGenericNational) {
      const title = classifyChinaLocations(raw?.title, { confidence: 0.85, basis: "job_title_location" });
      const titleSpecific = title.regions.filter((region) => region.provinceCode);
      if (titleSpecific.length) return { ...explicit, regions: titleSpecific, inferred: true, inferenceSource: "job_title" };
    }
    return { ...explicit, inferred: false };
  }
  const sourceRegions = source?.candidate?.regions || source?.candidate?.scopeRegions || [];
  if (explicit.status === "unknown" && sourceRegions.length && /^official_/.test(String(source?.candidate?.authority || ""))) {
    return {
      ...explicit,
      status: "china",
      inferred: true,
      regions: sourceRegions.map((region) => ({ ...region, confidence: Math.min(0.75, Number(region.confidence || 0.75)), basis: "authoritative_source_scope" })),
    };
  }
  return { ...explicit, inferred: false };
}

export function listChinaRegions({ provinceCode = null } = {}) {
  return CHINA_REGIONS
    .filter((province) => !provinceCode || province.provinceCode === provinceCode)
    .map((province) => ({
      provinceCode: province.provinceCode,
      provinceName: province.provinceName,
      label: province.label,
      municipality: province.municipality,
      cities: province.cities.map(({ cityCode, cityName }) => ({ cityCode, cityName, label: province.municipality ? province.label : `${province.label}-${cityName}` })),
    }));
}

/**
 * @param {any} job
 * @param {{ provinceCode?: string | null, cityCode?: string | null }} [options]
 */
export function jobMatchesRegion(job, { provinceCode = null, cityCode = null } = {}) {
  if (!provinceCode && !cityCode) return true;
  return (job?.workLocations || job?.regions || []).some((region) => (!provinceCode || region.provinceCode === provinceCode) && (!cityCode || region.cityCode === cityCode));
}

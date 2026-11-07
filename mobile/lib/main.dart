import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

// Android emulator: http://10.0.2.2:4000
// Physical device: flutter run --dart-define=IWACUMALL_API_URL=http://YOUR_LAN_IP:4000
// Production: use HTTPS only.
const apiBase = String.fromEnvironment(
  'IWACUMALL_API_URL',
  defaultValue: 'http://10.0.2.2:4000',
);
const blue = Color(0xFF1455D9);
const navy = Color(0xFF081F62);
const gold = Color(0xFFFFC400);
const canvasColor = Color(0xFFF6F8FC);

String money(dynamic amount) {
  final text = (amount is num ? amount.toInt() : int.tryParse('$amount') ?? 0)
      .toString();
  final reversed = text.split('').reversed.toList();
  final parts = <String>[];
  for (var i = 0; i < reversed.length; i += 3) {
    parts.add(reversed.skip(i).take(3).toList().reversed.join());
  }
  return 'RWF ${parts.reversed.join(',')}';
}

int countOf(dynamic v) => v is int ? v : int.tryParse('$v') ?? 0;
String textOf(dynamic v) => v?.toString() ?? '';

class ShopState extends ChangeNotifier {
  ShopState(this.prefs);
  final SharedPreferences prefs;
  String? token;
  Map<String, dynamic>? user;
  List<Map<String, dynamic>> products = [];
  List<Map<String, dynamic>> categories = [];
  List<Map<String, dynamic>> orders = [];
  Map<String, int> cart = {};
  String? error;
  bool loading = false;

  bool get signedIn => token != null && token!.isNotEmpty;
  int get cartCount => cart.values.fold<int>(0, (a, b) => a + b);
  int get subtotal => cart.entries.fold<int>(0, (sum, line) {
        final item = products.where((p) => p['id'] == line.key).firstOrNull;
        return sum + countOf(item?['price']) * line.value;
      });
  List<Map<String, dynamic>> get cartProducts => products
      .where((p) => cart.containsKey(p['id']))
      .toList(growable: false);

  Future<Map<String, dynamic>> request(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
  }) async {
    try {
      final url = Uri.parse('$apiBase/api$path');
      final headers = <String, String>{'Content-Type': 'application/json'};
      if (token != null) headers['Authorization'] = 'Bearer $token';
      late http.Response response;
      switch (method) {
        case 'POST':
          response = await http.post(url, headers: headers, body: jsonEncode(body));
          break;
        case 'PATCH':
          response = await http.patch(url, headers: headers, body: jsonEncode(body));
          break;
        default:
          response = await http.get(url, headers: headers);
      }
      final decoded = jsonDecode(response.body);
      if (decoded is! Map<String, dynamic>) {
        throw Exception('Unexpected server response');
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw Exception(textOf(decoded['error']).isNotEmpty
            ? decoded['error']
            : 'Request failed (${response.statusCode})');
      }
      return decoded;
    } catch (e) {
      if (e is Exception) rethrow;
      throw Exception('Could not connect to the IwacuMall server');
    }
  }

  Future<void> initialize() async {
    token = prefs.getString('token');
    final rawUser = prefs.getString('user');
    if (rawUser != null) {
      final u = jsonDecode(rawUser);
      if (u is Map<String, dynamic>) user = u;
    }
    final rawCart = prefs.getString('cart');
    if (rawCart != null) {
      final c = jsonDecode(rawCart);
      if (c is Map) {
        cart = c.map((key, value) =>
            MapEntry(textOf(key), countOf(value)));
      }
    }
    await refresh();
    if (signedIn) {
      try {
        final data = await request('/me');
        user = Map<String, dynamic>.from(data['user']);
        await prefs.setString('user', jsonEncode(user));
      } catch (_) {
        await signOut();
      }
    }
    notifyListeners();
  }

  Future<void> refresh() async {
    loading = true;
    error = null;
    notifyListeners();
    try {
      final responses = await Future.wait([
        request('/products'),
        request('/categories'),
      ]);
      products = (responses[0]['products'] as List)
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      categories = (responses[1]['categories'] as List)
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
    } catch (e) {
      error = '$e';
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> authenticate({
    required bool register,
    required String email,
    required String password,
    String name = '',
  }) async {
    final data = await request(
      register ? '/auth/register' : '/auth/login',
      method: 'POST',
      body: {'name': name, 'email': email, 'password': password},
    );
    token = textOf(data['token']);
    user = Map<String, dynamic>.from(data['user']);
    await prefs.setString('token', token!);
    await prefs.setString('user', jsonEncode(user));
    notifyListeners();
  }

  Future<void> signOut() async {
    if (token != null) {
      try { await request('/auth/logout', method: 'POST'); } catch (_) {}
    }
    token = null;
    user = null;
    orders = [];
    await prefs.remove('token');
    await prefs.remove('user');
    notifyListeners();
  }

  void add(String productId) {
    final product = products.where((p) => p['id'] == productId).firstOrNull;
    if (product == null) return;
    if ((cart[productId] ?? 0) >= countOf(product['stock'])) return;
    cart[productId] = (cart[productId] ?? 0) + 1;
    _saveCart();
  }

  void changeQuantity(String productId, int delta) {
    final product = products.where((p) => p['id'] == productId).firstOrNull;
    if (product == null) return;
    final count = ((cart[productId] ?? 0) + delta)
        .clamp(0, countOf(product['stock']));
    if (count == 0) {
      cart.remove(productId);
    } else {
      cart[productId] = count;
    }
    _saveCart();
  }

  void _saveCart() {
    prefs.setString('cart', jsonEncode(cart));
    notifyListeners();
  }

  Future<String> placeOrder({
    required String customerName,
    required String phone,
    required String city,
    required String address,
    String note = '',
  }) async {
    final data = await request('/orders', method: 'POST', body: {
      'customerName': customerName,
      'phone': phone,
      'city': city,
      'address': address,
      'note': note,
      'items': cart.entries
          .map((e) => {'productId': e.key, 'quantity': e.value})
          .toList(),
    });
    cart.clear();
    _saveCart();
    await refresh();
    return textOf((data['order'] as Map)['id']);
  }

  Future<void> loadOrders() async {
    if (!signedIn) return;
    final data = await request('/me/orders');
    orders = (data['orders'] as List)
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
    notifyListeners();
  }
}

class ShopScope extends InheritedNotifier<ShopState> {
  const ShopScope({super.key, required ShopState model, required super.child})
      : super(notifier: model);
  static ShopState of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ShopScope>()!.notifier!;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  final model = ShopState(prefs);
  await model.initialize();
  runApp(ShopScope(model: model, child: const IwacuMallApp()));
}

class IwacuMallApp extends StatelessWidget {
  const IwacuMallApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'IwacuMall',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          useMaterial3: true,
          scaffoldBackgroundColor: canvasColor,
          colorScheme: ColorScheme.fromSeed(
            seedColor: blue,
            primary: blue,
            secondary: gold,
            surface: Colors.white,
          ),
          appBarTheme: const AppBarTheme(
            backgroundColor: Colors.white,
            foregroundColor: navy,
            elevation: 0,
          ),
          filledButtonTheme: FilledButtonThemeData(
            style: FilledButton.styleFrom(
              backgroundColor: blue,
              foregroundColor: Colors.white,
              minimumSize: const Size(0, 50),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(13),
              ),
            ),
          ),
          inputDecorationTheme: InputDecorationTheme(
            filled: true,
            fillColor: Colors.white,
            contentPadding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
          ),
        ),
        home: const ShopShell(),
      );
}

class ShopShell extends StatefulWidget {
  const ShopShell({super.key});
  @override
  State<ShopShell> createState() => _ShopShellState();
}
class _ShopShellState extends State<ShopShell> {
  int current = 0;
  @override
  Widget build(BuildContext context) {
    final model = ShopScope.of(context);
    final pages = [const ShopHome(), const CartPage(), const OrdersPage(), const AccountPage()];
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 72,
        title: Row(children: [
          ClipRRect(borderRadius: BorderRadius.circular(10), child: Image.asset('assets/logo.png',width:42,height:42)),
          const SizedBox(width:10),
          RichText(text: const TextSpan(children: [
            TextSpan(text:'Iwacu',style:TextStyle(color:navy,fontWeight:FontWeight.w900,fontSize:23)),
            TextSpan(text:'Mall',style:TextStyle(color:Color(0xFFEDA900),fontWeight:FontWeight.w900,fontSize:23)),
          ])),
        ]),
        actions: [IconButton(onPressed:()=>setState(()=>current=2), icon:const Icon(Icons.receipt_long_outlined))],
      ),
      body: pages[current],
      bottomNavigationBar: NavigationBar(
        selectedIndex: current,
        onDestinationSelected: (i) => setState(() => current = i),
        indicatorColor: const Color(0xFFDCE9FF),
        destinations: [
          const NavigationDestination(icon:Icon(Icons.storefront_outlined),selectedIcon:Icon(Icons.storefront),label:'Shop'),
          NavigationDestination(icon:Badge(isLabelVisible:model.cartCount>0,label:Text('${model.cartCount}'),child:const Icon(Icons.shopping_bag_outlined)),selectedIcon:const Icon(Icons.shopping_bag),label:'Cart'),
          const NavigationDestination(icon:Icon(Icons.inventory_2_outlined),selectedIcon:Icon(Icons.inventory_2),label:'Orders'),
          const NavigationDestination(icon:Icon(Icons.person_outline),selectedIcon:Icon(Icons.person),label:'Account'),
        ],
      ),
    );
  }
}

String imageUrl(String path) => path.startsWith('https://') ? path : '$apiBase$path';
Widget productImage(String path, {BoxFit fit = BoxFit.cover}) {
  if (path.isEmpty) return const Center(child:Icon(Icons.shopping_bag,size:60,color:blue));
  final url = imageUrl(path);
  return Image.network(url,fit:fit,errorBuilder:(_,__,___)=>const Center(child:Icon(Icons.image_not_supported_outlined)));
}

class ShopHome extends StatefulWidget {
  const ShopHome({super.key});
  @override
  State<ShopHome> createState() => _ShopHomeState();
}
class _ShopHomeState extends State<ShopHome> {
  String category = 'all';
  String query = '';
  @override
  Widget build(BuildContext context) {
    final model = ShopScope.of(context);
    final products = model.products.where((p) =>
        (category == 'all' || p['categorySlug'] == category) &&
        ('$query'.isEmpty || '${p['name']} ${p['description']}'.toLowerCase().contains(query.toLowerCase())))
        .toList();
    return RefreshIndicator(
      onRefresh:model.refresh,
      child: CustomScrollView(slivers: [
        SliverToBoxAdapter(child:Column(children:[
          Container(
            margin:const EdgeInsets.fromLTRB(16,18,16,15),
            decoration:BoxDecoration(
              gradient:const LinearGradient(colors:[navy,blue]),
              borderRadius:BorderRadius.circular(22),
            ),
            child:Padding(
              padding:const EdgeInsets.all(22),
              child:Row(children:[
                Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
                  const Text('✦ YOUR HOME OF EVERYTHING',style:TextStyle(color:gold,fontSize:10,fontWeight:FontWeight.w900,letterSpacing:1.1)),
                  const SizedBox(height:12),
                  const Text('Shop happy.\nLive easy.',style:TextStyle(fontSize:31,height:1.13,fontWeight:FontWeight.w900,color:Colors.white)),
                  const SizedBox(height:10),
                  const Text('All your favorites, closer than ever.',style:TextStyle(color:Color(0xFFDDE9FF),fontSize:12)),
                  const SizedBox(height:13),
                  const Icon(Icons.arrow_forward_rounded,color:gold,size:27),
                ])),
                ClipRRect(borderRadius:BorderRadius.circular(18),child:Image.asset('assets/logo.png',width:116,height:116)),
              ]),
            ),
          ),
          Padding(
            padding:const EdgeInsets.fromLTRB(16,0,16,15),
            child:TextField(
              onChanged:(value)=>setState(()=>query=value),
              decoration:const InputDecoration(prefixIcon:Icon(Icons.search),hintText:'Search products...',border:OutlineInputBorder()),
            ),
          ),
          const Padding(padding:EdgeInsets.fromLTRB(16,7,16,10),child:Row(children:[Text('Explore categories',style:TextStyle(fontSize:19,fontWeight:FontWeight.w900,color:navy))])),
          SizedBox(height:45,child:ListView(scrollDirection:Axis.horizontal,padding:const EdgeInsets.symmetric(horizontal:16),children:[
            _categoryChip('all','All',category=='all',()=>setState(()=>category='all')),
            ...model.categories.map((c)=>_categoryChip(textOf(c['slug']),textOf(c['name']),category==c['slug'],()=>setState(()=>category=textOf(c['slug'])))),
          ])),
          const Padding(padding:EdgeInsets.fromLTRB(16,24,16,14),child:Row(children:[Text('Find something you love',style:TextStyle(fontSize:19,fontWeight:FontWeight.w900,color:navy))])),
          if(model.error!=null) Padding(padding:const EdgeInsets.all(16),child:Column(children:[Text(model.error!,style:const TextStyle(color:Colors.red)),TextButton(onPressed:model.refresh,child:const Text('Retry'))])),
          if(model.loading)const LinearProgressIndicator(),
        ])),
        SliverPadding(
          padding:const EdgeInsets.fromLTRB(14,0,14,34),
          sliver:SliverGrid.builder(
            itemCount:products.length,
            gridDelegate:const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount:2,mainAxisSpacing:13,crossAxisSpacing:13,childAspectRatio:.69),
            itemBuilder:(context,i){final p=products[i];return ProductTile(product:p,onAdd:(){model.add(textOf(p['id']));ScaffoldMessenger.of(context).showSnackBar(SnackBar(content:Text('${p['name']} added to cart'),duration:const Duration(seconds:1)));});},
          ),
        ),
      ]),
    );
  }
  Widget _categoryChip(String value,String label,bool selected,VoidCallback onTap)=>Padding(
    padding:const EdgeInsets.only(right:8),
    child:ChoiceChip(label:Text(label),selected:selected,onSelected:(_)=>onTap(),
      selectedColor:blue,labelStyle:TextStyle(color:selected?Colors.white:navy,fontWeight:FontWeight.w700,fontSize:12)),
  );
}

class ProductTile extends StatelessWidget {
  const ProductTile({super.key,required this.product,required this.onAdd});
  final Map<String,dynamic> product;
  final VoidCallback onAdd;
  @override
  Widget build(BuildContext context) => Container(
    decoration:BoxDecoration(color:Colors.white,borderRadius:BorderRadius.circular(17),boxShadow:[BoxShadow(color:const Color(0x0E081F62),blurRadius:14,offset:const Offset(0,5))]),
    clipBehavior:Clip.antiAlias,
    child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
      Expanded(child:SizedBox(width:double.infinity,child:productImage(textOf(product['imageUrl'])))),
      Padding(padding:const EdgeInsets.all(11),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
        Text(textOf(product['category']).toUpperCase(),style:const TextStyle(fontSize:9,letterSpacing:.7,color:Colors.blueGrey,fontWeight:FontWeight.w800)),
        const SizedBox(height:5),
        Text(textOf(product['name']),maxLines:1,overflow:TextOverflow.ellipsis,style:const TextStyle(fontWeight:FontWeight.w900,fontSize:14,color:navy)),
        const SizedBox(height:8),
        Row(children:[Expanded(child:Text(money(product['price']),maxLines:1,style:const TextStyle(color:blue,fontWeight:FontWeight.w900,fontSize:13))),
          SizedBox(width:33,height:33,child:IconButton.filledTonal(icon:const Icon(Icons.add,size:20),padding:EdgeInsets.zero,onPressed:countOf(product['stock'])>0?onAdd:null)),
        ]),
      ])),
    ]),
  );
}

class CartPage extends StatelessWidget {
  const CartPage({super.key});
  @override
  Widget build(BuildContext context) {
    final model=ShopScope.of(context);
    return Column(children:[
      Padding(padding:const EdgeInsets.fromLTRB(18,22,18,15),child:Row(children:[Text('Your cart',style:Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight:FontWeight.w900,color:navy)),const Spacer(),Text('${model.cartCount} items')])),
      Expanded(child:model.cartProducts.isEmpty?const Center(child:Column(mainAxisSize:MainAxisSize.min,children:[Icon(Icons.shopping_bag_outlined,size:66,color:blue),SizedBox(height:15),Text('Your cart is empty',style:TextStyle(fontWeight:FontWeight.w800,fontSize:18))])):ListView.builder(padding:const EdgeInsets.symmetric(horizontal:16),itemCount:model.cartProducts.length,itemBuilder:(context,index){final p=model.cartProducts[index],id=textOf(p['id']);return Card(color:Colors.white,margin:const EdgeInsets.only(bottom:12),child:Padding(padding:const EdgeInsets.all(10),child:Row(children:[SizedBox(width:88,height:92,child:ClipRRect(borderRadius:BorderRadius.circular(11),child:productImage(textOf(p['imageUrl'])))),const SizedBox(width:13),Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(textOf(p['name']),style:const TextStyle(fontWeight:FontWeight.w800)),const SizedBox(height:8),Text(money(p['price']),style:const TextStyle(color:blue,fontWeight:FontWeight.w800)),Row(children:[IconButton(icon:const Icon(Icons.remove_circle_outline),onPressed:()=>model.changeQuantity(id,-1)),Text('${model.cart[id]}'),IconButton(icon:const Icon(Icons.add_circle_outline),onPressed:()=>model.changeQuantity(id,1))])]))])));}),
      ),
      Container(color:Colors.white,padding:const EdgeInsets.all(18),child:SafeArea(top:false,child:Column(children:[Row(children:[const Text('Subtotal',style:TextStyle(fontWeight:FontWeight.w700)),const Spacer(),Text(money(model.subtotal),style:const TextStyle(fontSize:21,fontWeight:FontWeight.w900,color:blue))]),const SizedBox(height:7),const Text('Delivery charges, if any, are confirmed separately by the store.',style:TextStyle(fontSize:11,color:Colors.blueGrey)),const SizedBox(height:15),SizedBox(width:double.infinity,child:FilledButton(onPressed:model.cartCount==0?null:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>const CheckoutPage())),child:const Text('Proceed to checkout  →')))]))),
    ]);
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});
  @override
  State<LoginPage> createState()=>_LoginPageState();
}
class _LoginPageState extends State<LoginPage> {
  final form=GlobalKey<FormState>();
  final name=TextEditingController(),email=TextEditingController(),password=TextEditingController();
  bool register=false,busy=false;
  String? error;
  @override
  void dispose(){name.dispose();email.dispose();password.dispose();super.dispose();}
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar:AppBar(title:const Text('Your IwacuMall account')),
    body:SingleChildScrollView(padding:const EdgeInsets.all(23),child:Form(key:form,child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      const SizedBox(height:15),Center(child:Image.asset('assets/logo.png',width:115,height:115)),const SizedBox(height:20),
      Text(register?'Join IwacuMall':'Welcome back',textAlign:TextAlign.center,style:const TextStyle(fontSize:26,fontWeight:FontWeight.w900,color:navy)),
      const SizedBox(height:25),
      if(register)...[TextFormField(controller:name,decoration:const InputDecoration(labelText:'Full name'),validator:(v)=>(v??'').trim().length<2?'Please enter your name':null),const SizedBox(height:14)],
      TextFormField(controller:email,keyboardType:TextInputType.emailAddress,decoration:const InputDecoration(labelText:'Email address'),validator:(v)=>(v??'').contains('@')?null:'Enter a valid email'),const SizedBox(height:14),
      TextFormField(controller:password,obscureText:true,decoration:const InputDecoration(labelText:'Password'),validator:(v)=>(v??'').length<(register?10:1)?'Password is too short':null),
      if(error!=null)Padding(padding:const EdgeInsets.only(top:15),child:Text(error!,style:const TextStyle(color:Colors.red))),
      const SizedBox(height:23),FilledButton(onPressed:busy?null:submit,child:Text(busy?'Please wait...':register?'Create account':'Sign in')),
      TextButton(onPressed:()=>setState(()=>register=!register),child:Text(register?'Already have an account? Sign in':'New here? Create an account')),
    ]))),
  );
  Future<void> submit() async {
    if(!form.currentState!.validate())return;
    setState(()=>busy=true);
    try{await ShopScope.of(context).authenticate(register:register,name:name.text,email:email.text,password:password.text);if(mounted)Navigator.pop(context,true);}catch(e){setState(()=>error='$e');}finally{if(mounted)setState(()=>busy=false);}
  }
}

class CheckoutPage extends StatefulWidget {
  const CheckoutPage({super.key});
  @override
  State<CheckoutPage> createState()=>_CheckoutPageState();
}
class _CheckoutPageState extends State<CheckoutPage> {
  final form=GlobalKey<FormState>();
  final name=TextEditingController(),phone=TextEditingController(),city=TextEditingController(text:'Kigali'),address=TextEditingController(),note=TextEditingController();
  bool busy=false;
  String? error;
  @override
  void didChangeDependencies(){super.didChangeDependencies();if(name.text.isEmpty)name.text=textOf(ShopScope.of(context).user?['name']);}
  @override
  void dispose(){name.dispose();phone.dispose();city.dispose();address.dispose();note.dispose();super.dispose();}
  @override
  Widget build(BuildContext context){final model=ShopScope.of(context);return Scaffold(appBar:AppBar(title:const Text('Checkout')),body:SingleChildScrollView(padding:const EdgeInsets.all(19),child:Form(key:form,child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
    Text('Order subtotal: ${money(model.subtotal)}',style:const TextStyle(fontWeight:FontWeight.w900,fontSize:21,color:navy)),const SizedBox(height:7),const Text('Cash on delivery. Any delivery fees are confirmed by the store separately.',style:TextStyle(color:Colors.blueGrey,fontSize:12)),const SizedBox(height:25),
    TextFormField(controller:name,decoration:const InputDecoration(labelText:'Full name'),validator:(v)=>(v??'').trim().length>=2?null:'Please enter your name'),const SizedBox(height:13),
    TextFormField(controller:phone,keyboardType:TextInputType.phone,decoration:const InputDecoration(labelText:'Phone number'),validator:(v)=>(v??'').trim().length>=8?null:'Enter your phone number'),const SizedBox(height:13),
    TextFormField(controller:city,decoration:const InputDecoration(labelText:'City'),validator:(v)=>(v??'').trim().length>=2?null:'Enter your city'),const SizedBox(height:13),
    TextFormField(controller:address,decoration:const InputDecoration(labelText:'Delivery address'),validator:(v)=>(v??'').trim().length>=5?null:'Enter your delivery address'),const SizedBox(height:13),
    TextFormField(controller:note,maxLines:2,decoration:const InputDecoration(labelText:'Notes (optional)')),
    if(error!=null)Padding(padding:const EdgeInsets.only(top:15),child:Text(error!,style:const TextStyle(color:Colors.red))),
    const SizedBox(height:22),FilledButton(onPressed:busy?null:submit,child:Text(busy?'Placing order...':'Place order — ${money(model.subtotal)}')),
  ]))));}
  Future<void> submit() async {
    if(!form.currentState!.validate())return;
    final model=ShopScope.of(context);
    if(!model.signedIn){final result=await Navigator.push<bool>(context,MaterialPageRoute(builder:(_)=>const LoginPage()));if(result!=true||!mounted)return;}
    setState(()=>busy=true);
    try{final id=await model.placeOrder(customerName:name.text,phone:phone.text,city:city.text,address:address.text,note:note.text);if(!mounted)return;await showDialog<void>(context:context,builder:(c)=>AlertDialog(title:const Text('Order placed! 🎉'),content:Text('Order #${id.substring(0,8).toUpperCase()} has been received. Check Orders for updates.'),actions:[TextButton(onPressed:()=>Navigator.pop(c),child:const Text('Done'))]));if(mounted)Navigator.pop(context);}catch(e){setState(()=>error='$e');}finally{if(mounted)setState(()=>busy=false);}
  }
}

class OrdersPage extends StatefulWidget {
  const OrdersPage({super.key});
  @override
  State<OrdersPage> createState()=>_OrdersPageState();
}
class _OrdersPageState extends State<OrdersPage> {
  bool refreshing=false;
  @override
  void initState(){super.initState();WidgetsBinding.instance.addPostFrameCallback((_){if(mounted)load();});}
  Future<void> load() async {final model=ShopScope.of(context);if(!model.signedIn)return;setState(()=>refreshing=true);try{await model.loadOrders();}catch(e){if(mounted)ScaffoldMessenger.of(context).showSnackBar(SnackBar(content:Text('$e')));}finally{if(mounted)setState(()=>refreshing=false);}}
  @override
  Widget build(BuildContext context){final model=ShopScope.of(context);return Column(children:[Padding(padding:const EdgeInsets.all(19),child:Row(children:[const Text('My orders',style:TextStyle(fontSize:25,fontWeight:FontWeight.w900,color:navy)),const Spacer(),IconButton(onPressed:load,icon:const Icon(Icons.refresh))])),Expanded(child:!model.signedIn?Center(child:Column(mainAxisSize:MainAxisSize.min,children:[const Text('Sign in to track your orders'),const SizedBox(height:15),FilledButton(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>const LoginPage())),child:const Text('Sign in'))])):refreshing?const Center(child:CircularProgressIndicator()):model.orders.isEmpty?const Center(child:Text('No orders yet. Enjoy shopping!')):ListView.builder(padding:const EdgeInsets.fromLTRB(15,0,15,25),itemCount:model.orders.length,itemBuilder:(context,i){final order=model.orders[i];final lines=(order['items'] as List?) ?? [];return Card(color:Colors.white,margin:const EdgeInsets.only(bottom:13),child:Padding(padding:const EdgeInsets.all(16),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Row(children:[Expanded(child:Text('Order #${textOf(order['id']).substring(0,8).toUpperCase()}',style:const TextStyle(fontWeight:FontWeight.w900,color:navy))),Chip(label:Text(textOf(order['status']).replaceAll('_',' '),style:const TextStyle(fontSize:10)))]),const SizedBox(height:5),Text(money(order['total']),style:const TextStyle(color:blue,fontWeight:FontWeight.w900,fontSize:18)),const Divider(height:24),...lines.map((item)=>Padding(padding:const EdgeInsets.only(bottom:5),child:Text('${item['product_name']} × ${item['quantity']}',style:const TextStyle(color:Colors.blueGrey,fontSize:12)))),const SizedBox(height:5),const Text('Payment: cash on delivery',style:TextStyle(fontSize:11,color:Colors.blueGrey))])));}))]);}
}

class AccountPage extends StatelessWidget {
  const AccountPage({super.key});
  @override
  Widget build(BuildContext context){final model=ShopScope.of(context);return Padding(padding:const EdgeInsets.all(22),child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[const SizedBox(height:30),CircleAvatar(radius:43,backgroundColor:const Color(0xFFDFE9FF),child:const Icon(Icons.person,size:45,color:blue)),const SizedBox(height:18),Text(model.signedIn?'Hello, ${model.user?['name']??'shopper'}':'Welcome to IwacuMall',textAlign:TextAlign.center,style:const TextStyle(fontSize:25,color:navy,fontWeight:FontWeight.w900)),const SizedBox(height:9),Text(model.user?['email']??'Your home of everything',textAlign:TextAlign.center,style:const TextStyle(color:Colors.blueGrey)),const SizedBox(height:28),if(!model.signedIn)FilledButton(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>const LoginPage())),child:const Text('Sign in / Register')) else OutlinedButton.icon(onPressed:() async {await model.signOut();},icon:const Icon(Icons.logout),label:const Text('Sign out')),const SizedBox(height:28),const Text('Need help with an order? Contact the store using its official customer service details once configured.',textAlign:TextAlign.center,style:TextStyle(fontSize:12,color:Colors.blueGrey,height:1.6))]));}
}

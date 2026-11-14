import 'dart:collection';
import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:google_sign_in/google_sign_in.dart';

// Use the production API by default on phones and release builds. Override this
// endpoint with IWACUMALL_API_URL when developing against a local server.
const apiBase = String.fromEnvironment(
  'IWACUMALL_API_URL',
  defaultValue: 'https://iwacumall.com',
);
const blue = Color(0xFF1455D9);
const navy = Color(0xFF081F62);
const gold = Color(0xFFFFC400);
const canvasColor = Color(0xFFF6F8FC);
const invoicePlatform = MethodChannel('com.iwacumall.app/invoice');

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
String cartLineKey(String productId, [String variantId = '']) => '$productId::$variantId';
String productIdFromCartKey(String key) => key.split('::').first;
String variantIdFromCartKey(String key) => key.contains('::') ? key.split('::').skip(1).join('::') : '';
List<Map<String, dynamic>> productVariantsOf(Map<String, dynamic>? product) {
  final raw = product?['variants'];
  if (raw is! List) return [];
  return raw.whereType<Map>().map((item) => Map<String, dynamic>.from(item)).toList();
}

class ShopState extends ChangeNotifier {
  ShopState(this.prefs, this.secureStorage);
  final SharedPreferences prefs;
  final FlutterSecureStorage secureStorage;
  String? token;
  Map<String, dynamic>? user;
  List<Map<String, dynamic>> products = [];
  int productsTotal = 0;
  bool productsHasMore = false;
  bool loadingMoreProducts = false;
  int productsPage = 1;
  String catalogCategory = 'all';
  String catalogSearch = '';
  int _catalogRequestVersion = 0;
  List<Map<String, dynamic>> categories = [];
  List<Map<String, dynamic>> orders = [];
  bool ordersHasMore = false;
  bool loadingMoreOrders = false;
  int ordersSkip = 0;
  List<Map<String, dynamic>> paymentMethods = [];
  Map<String, dynamic> storeConfig = {};
  Map<String, int> cart = {};
  String? error;
  bool loading = false;
  bool _googleSignInInitialized = false;

  bool get signedIn => token != null && token!.isNotEmpty;
  int get cartCount => cart.values.fold<int>(0, (a, b) => a + b);
  int quantityForProduct(String productId) => cart.entries
      .where((line) => productIdFromCartKey(line.key) == productId)
      .fold<int>(0, (total, line) => total + line.value);
  int get subtotal => cart.entries.fold<int>(0, (sum, line) {
        final productId = productIdFromCartKey(line.key);
        final variantId = variantIdFromCartKey(line.key);
        final item = products.where((p) => p['id'] == productId).firstOrNull;
        final variants = productVariantsOf(item);
        final variant = variants.where((option) => option['id'] == variantId).firstOrNull;
        return sum + countOf(variant?['price'] ?? item?['price']) * line.value;
      });
  List<Map<String, dynamic>> get cartProducts {
    final result = <Map<String, dynamic>>[];
    for (final line in cart.entries) {
      final productId = productIdFromCartKey(line.key);
      final variantId = variantIdFromCartKey(line.key);
      final product = products.where((item) => item['id'] == productId).firstOrNull;
      if (product == null) continue;
      final variants = productVariantsOf(product);
      final variant = variants.where((option) => option['id'] == variantId).firstOrNull;
      final variantLabel = variant == null ? '' : '${textOf(variant['type'])}: ${textOf(variant['value'])}';
      result.add({...product, '_cartKey': line.key, '_variantId': variantId, '_variantLabel': variantLabel, '_linePrice': variant?['price'] ?? product['price']});
    }
    return result;
  }
  List<String> get cartIssues {
    final issues = <String>{};
    final totals = <String, int>{};
    for (final line in cart.entries) {
      final productId = productIdFromCartKey(line.key);
      final variantId = variantIdFromCartKey(line.key);
      final product = products.where((item) => item['id'] == productId).firstOrNull;
      final variants = productVariantsOf(product);
      final invalidVariant = variants.isEmpty ? variantId.isNotEmpty : !variants.any((option) => option['id'] == variantId);
      if (product == null || product['active'] == false || invalidVariant) {
        issues.add(line.key);
      }
      totals[productId] = (totals[productId] ?? 0) + line.value;
    }
    for (final entry in totals.entries) {
      final product = products.where((item) => item['id'] == entry.key).firstOrNull;
      if (product == null || product['active'] == false ||
          (product['trackInventory'] == true && entry.value > countOf(product['stock']).clamp(0, 100)) ||
          (product['trackInventory'] != true && entry.value > 100)) {
        issues.addAll(cart.keys.where((key) => productIdFromCartKey(key) == entry.key));
      }
    }
    return issues.toList(growable: false);
  }

  Future<Map<String, dynamic>> request(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
    Map<String, String>? extraHeaders,
  }) async {
    try {
      if (kReleaseMode) {
        if (!apiBase.startsWith('https://')) {
          throw Exception('Release builds require a secure HTTPS API endpoint.');
        }
        if (apiBase.contains('10.0.2.2') || apiBase.contains('localhost') || apiBase.contains('127.0.0.1')) {
          throw Exception('Default emulator or local development URL cannot be used in release builds.');
        }
      }
      final url = Uri.parse('$apiBase/api$path');
      final headers = <String, String>{
        'Content-Type': 'application/json',
        'X-IwacuMall-Client': 'mobile',
        if (extraHeaders != null) ...extraHeaders,
      };
      if (token != null) headers['Authorization'] = 'Bearer $token';
      late http.Response response;
      final retryAllowed = method == 'GET' ||
          (method == 'POST' && path == '/orders' && extraHeaders?.containsKey('Idempotency-Key') == true);
      for (var attempt = 0; ; attempt++) {
        try {
          switch (method) {
            case 'POST':
              response = await http.post(url, headers: headers, body: jsonEncode(body)).timeout(const Duration(seconds: 15));
              break;
            case 'PATCH':
              response = await http.patch(url, headers: headers, body: jsonEncode(body)).timeout(const Duration(seconds: 15));
              break;
            default:
              response = await http.get(url, headers: headers).timeout(const Duration(seconds: 15));
          }
          break;
        } catch (error) {
          if (!retryAllowed || attempt >= 1) rethrow;
          await Future<void>.delayed(const Duration(milliseconds: 350));
        }
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
    try {
      token = await secureStorage.read(key: 'session_token');
    } catch (_) {
      token = null;
    }
    final legacyToken = prefs.getString('token');
    if ((token == null || token!.isEmpty) && legacyToken != null) {
      token = legacyToken;
      await secureStorage.write(key: 'session_token', value: token);
    }
    await prefs.remove('token');
    final rawUser = prefs.getString('user');
    if (rawUser != null) {
      final u = jsonDecode(rawUser);
      if (u is Map<String, dynamic>) user = u;
    }
    final rawCart = prefs.getString('cart');
    if (rawCart != null) {
      final c = jsonDecode(rawCart);
      if (c is Map) {
        cart = c.map((key, value) {
          final oldKey = textOf(key);
          return MapEntry(cartLineKey(productIdFromCartKey(oldKey), variantIdFromCartKey(oldKey)), countOf(value));
        });
      }
    }
    await refresh();
    if (signedIn) {
      try {
        final data = await request('/me');
        user = Map<String, dynamic>.from(data['user']);
        await prefs.setString('user', jsonEncode(user));
      } catch (e) {
        if ('$e'.contains('401') || '$e'.contains('sign in') || '$e'.contains('Unauthorized')) {
          await signOut();
        }
      }
    }
    notifyListeners();
  }

  Future<void> refresh() async {
    final requestVersion = ++_catalogRequestVersion;
    loading = true;
    loadingMoreProducts = false;
    error = null;
    notifyListeners();
    try {
      final responses = await Future.wait([
        request(_catalogPath(page: 1)),
        request('/categories'),
        request('/config'),
      ]);
      if (requestVersion == _catalogRequestVersion) {
        products = (responses[0]['products'] as List)
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        productsTotal = countOf(responses[0]['total']);
        productsPage = countOf(responses[0]['page']).clamp(1, 1000000).toInt();
        productsHasMore = productsPage < countOf(responses[0]['totalPages']);
      }
      categories = (responses[1]['categories'] as List)
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      storeConfig = Map<String, dynamic>.from(responses[2]);
      paymentMethods = (storeConfig['paymentMethods'] as List? ?? [])
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
    } catch (e) {
      if (requestVersion == _catalogRequestVersion) error = '$e';
    } finally {
      if (requestVersion == _catalogRequestVersion) loading = false;
      notifyListeners();
    }
  }

  String _catalogPath({required int page}) {
    final query = <String, String>{'limit': '24', 'page': '$page'};
    if (catalogCategory != 'all') query['category'] = catalogCategory;
    if (catalogSearch.trim().isNotEmpty) query['search'] = catalogSearch.trim();
    return '/products?${Uri(queryParameters: query).query}';
  }

  Future<void> loadProducts({String? category, String? search, bool append = false}) async {
    if (category != null) catalogCategory = category;
    if (search != null) catalogSearch = search;
    if (append && (!productsHasMore || loadingMoreProducts)) return;
    final requestVersion = append ? _catalogRequestVersion : ++_catalogRequestVersion;
    final requestedPage = append ? productsPage + 1 : 1;
    if (append) {
      loadingMoreProducts = true;
    } else {
      loadingMoreProducts = false;
      loading = true;
      error = null;
      productsHasMore = false;
    }
    notifyListeners();
    try {
      final data = await request(_catalogPath(page: requestedPage));
      if (requestVersion != _catalogRequestVersion) return;
      final pageProducts = (data['products'] as List)
          .map((item) => Map<String, dynamic>.from(item))
          .toList();
      products = append ? [...products, ...pageProducts] : pageProducts;
      productsTotal = countOf(data['total']);
      productsPage = countOf(data['page']).clamp(1, 1000000).toInt();
      productsHasMore = productsPage < countOf(data['totalPages']);
    } catch (e) {
      if (requestVersion == _catalogRequestVersion) error = '$e';
    } finally {
      if (requestVersion == _catalogRequestVersion) {
        if (append) {
          loadingMoreProducts = false;
        } else {
          loading = false;
        }
        notifyListeners();
      }
    }
  }

  Future<bool> authenticate({
    required bool register,
    required String email,
    required String password,
    String name = '',
    String totpCode = '',
  }) async {
    final data = await request(
      register ? '/auth/register' : '/auth/login',
      method: 'POST',
      body: {'name': name, 'email': email, 'password': password, if (totpCode.isNotEmpty) 'totpCode': totpCode},
    );
    if (data['mfaRequired'] == true) return false;
    token = textOf(data['token']);
    if (token!.isEmpty) throw Exception('The server did not return a mobile session token');
    user = Map<String, dynamic>.from(data['user']);
    await secureStorage.write(key: 'session_token', value: token);
    await prefs.setString('user', jsonEncode(user));
    notifyListeners();
    return true;
  }

  Future<String> acquireGoogleIdToken() async {
    var serverClientId = textOf(storeConfig['googleWebClientId']);
    if (serverClientId.isEmpty) {
      final config = await request('/config');
      storeConfig = Map<String, dynamic>.from(config);
      serverClientId = textOf(storeConfig['googleWebClientId']);
    }
    if (serverClientId.isEmpty) {
      throw Exception('Google sign-in has not been configured on the IwacuMall server yet.');
    }
    final google = GoogleSignIn.instance;
    if (!_googleSignInInitialized) {
      await google.initialize(serverClientId: serverClientId);
      _googleSignInInitialized = true;
    }
    final account = await google.authenticate();
    final idToken = account.authentication.idToken;
    if (idToken == null || idToken.isEmpty) {
      throw Exception('Google did not provide a secure sign-in token. Check the Android OAuth client setup.');
    }
    return idToken;
  }

  Future<void> authenticateWithGoogle() async {
    final idToken = await acquireGoogleIdToken();
    final data = await request('/auth/google', method: 'POST', body: {'idToken': idToken});
    token = textOf(data['token']);
    if (token!.isEmpty) throw Exception('The server did not return a mobile session token.');
    user = Map<String, dynamic>.from(data['user']);
    await secureStorage.write(key: 'session_token', value: token);
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
    ordersHasMore = false;
    ordersSkip = 0;
    loadingMoreOrders = false;
    await secureStorage.delete(key: 'session_token');
    await prefs.remove('token');
    await prefs.remove('user');
    if (_googleSignInInitialized) {
      try { await GoogleSignIn.instance.signOut(); } catch (_) {}
    }
    notifyListeners();
  }

  void add(String productId, [int quantity = 1, String variantId = '']) {
    final product = products.where((p) => p['id'] == productId).firstOrNull;
    if (product == null || product['active'] == false) return;
    final variants = productVariantsOf(product);
    if (variants.isNotEmpty && !variants.any((option) => option['id'] == variantId)) return;
    final key = cartLineKey(productId, variantId);
    final current = cart[key] ?? 0;
    final limit = product['trackInventory'] == true ? countOf(product['stock']).clamp(0, 100).toInt() : 100;
    final available = limit - quantityForProduct(productId) + current;
    if (current >= available) return;
    cart[key] = (current + quantity).clamp(0, available).toInt();
    _clearPendingCheckoutKey();
    _saveCart();
  }

  void changeQuantity(String lineKey, int delta) {
    final productId = productIdFromCartKey(lineKey);
    final product = products.where((p) => p['id'] == productId).firstOrNull;
    if (product == null || product['active'] == false) return;
    final limit = product['trackInventory'] == true ? countOf(product['stock']).clamp(0, 100).toInt() : 100;
    final available = limit - quantityForProduct(productId) + (cart[lineKey] ?? 0);
    final count = ((cart[lineKey] ?? 0) + delta).clamp(0, available).toInt();
    if (count == 0) {
      cart.remove(lineKey);
    } else {
      cart[lineKey] = count;
    }
    _clearPendingCheckoutKey();
    _saveCart();
  }

  void reconcileCart() {
    final reserved = <String, int>{};
    for (final key in cart.keys.toList()) {
      final productId = productIdFromCartKey(key);
      final variantId = variantIdFromCartKey(key);
      final product = products.where((p) => p['id'] == productId).firstOrNull;
      final variants = productVariantsOf(product);
      final invalidVariant = variants.isEmpty ? variantId.isNotEmpty : !variants.any((option) => option['id'] == variantId);
      if (product == null || product['active'] == false || invalidVariant) {
        cart.remove(key);
        continue;
      }
      final limit = product['trackInventory'] == true ? countOf(product['stock']).clamp(0, 100).toInt() : 100;
      final available = (limit - (reserved[productId] ?? 0)).clamp(0, limit).toInt();
      final quantity = (cart[key] ?? 0).clamp(0, available).toInt();
      if (quantity == 0) cart.remove(key);
      else {
        cart[key] = quantity;
        reserved[productId] = (reserved[productId] ?? 0) + quantity;
      }
    }
    _clearPendingCheckoutKey();
    _saveCart();
  }

  void _clearPendingCheckoutKey() {
    prefs.remove('pending_checkout_key');
    prefs.remove('pending_checkout_fingerprint');
  }

  void _saveCart() {
    prefs.setString('cart', jsonEncode(cart));
    notifyListeners();
  }

  Future<Map<String, dynamic>> placeOrder({
    required String customerName,
    required String customerEmail,
    required String phone,
    required String city,
    required String address,
    required String paymentMethodId,
    String note = '',
  }) async {
    final body = {
      'customerName': customerName,
      'customerEmail': customerEmail,
      'phone': phone,
      'city': city,
      'address': address,
      'paymentMethodId': paymentMethodId,
      'note': note,
      'items': cart.entries
          .map((e) => {
            'productId': productIdFromCartKey(e.key),
            if (variantIdFromCartKey(e.key).isNotEmpty) 'variantId': variantIdFromCartKey(e.key),
            'quantity': e.value,
          })
          .toList(),
    };
    final fingerprint = jsonEncode(body);
    var key = prefs.getString('pending_checkout_key');
    if (key == null || prefs.getString('pending_checkout_fingerprint') != fingerprint) {
      final random = Random.secure();
      key = List.generate(24, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
      await prefs.setString('pending_checkout_key', key);
      await prefs.setString('pending_checkout_fingerprint', fingerprint);
    }
    final data = await request('/orders', method: 'POST', body: body, extraHeaders: {'Idempotency-Key': key});
    cart.clear();
    _clearPendingCheckoutKey();
    _saveCart();
    await refresh();
    if (signedIn) await loadOrders();
    return Map<String, dynamic>.from(data['order']);
  }

  Future<void> loadOrders({bool append = false}) async {
    if (!signedIn) return;
    if (append && (!ordersHasMore || loadingMoreOrders)) return;
    if (append) loadingMoreOrders = true;
    final pageSkip = append ? ordersSkip : 0;
    try {
      final data = await request('/me/orders?limit=20&skip=$pageSkip');
      final page = (data['orders'] as List)
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
      orders = append ? [...orders, ...page] : page;
      ordersHasMore = data['hasMore'] == true;
      ordersSkip = countOf(data['nextSkip']);
    } finally {
      if (append) loadingMoreOrders = false;
      notifyListeners();
    }
  }

  Future<void> loadMoreOrders() async {
    try {
      await loadOrders(append: true);
    } catch (_) {
      // Keep already-loaded orders visible; the orders screen reports the retry.
      rethrow;
    }
  }

  Future<void> requestReturn(String orderId, List<Map<String,dynamic>> items, String reason) async {
    if (!signedIn) throw Exception('Sign in to request a return.');
    await request('/orders/$orderId/returns', method:'POST', body:{'items':items,'reason':reason});
    await loadOrders();
  }

  Future<Uint8List> fetchInvoicePdf(String orderId) async {
    if (!signedIn) throw Exception('Sign in to download your invoice.');
    if (kReleaseMode && !apiBase.startsWith('https://')) {
      throw Exception('Invoice downloads require a secure HTTPS API endpoint.');
    }
    final uri = Uri.parse('$apiBase/api/orders/${Uri.encodeComponent(orderId)}/invoice.pdf');
    final headers = <String, String>{
      'X-IwacuMall-Client': 'mobile',
      'Authorization': 'Bearer $token',
    };
    final response = await http.get(uri, headers: headers).timeout(const Duration(seconds: 25));
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = jsonDecode(response.body);
      throw Exception(error is Map ? textOf(error['error']) : 'Invoice download failed (${response.statusCode}).');
    }
    final bytes = response.bodyBytes;
    if (!response.headers['content-type'].toString().toLowerCase().contains('application/pdf') ||
        bytes.length < 5 || String.fromCharCodes(bytes.take(5)) != '%PDF-') {
      throw Exception('The server did not return a valid PDF invoice.');
    }
    return bytes;
  }

  Future<void> updateProfileName(String name) async {
    final data = await request('/me', method: 'PATCH', body: {'name': name});
    user = Map<String, dynamic>.from(data['user']);
    await prefs.setString('user', jsonEncode(user));
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
  if (kReleaseMode && Uri.tryParse(apiBase)?.scheme != 'https') {
    runApp(const MaterialApp(
      home: Scaffold(
        body: Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text('This release build needs an HTTPS IWACUMALL_API_URL.'),
          ),
        ),
      ),
    ));
    return;
  }
  final prefs = await SharedPreferences.getInstance();
  const secureStorage = FlutterSecureStorage();
  final model = ShopState(prefs, secureStorage);
  runApp(ShopScope(model: model, child: const IwacuMallApp()));
  unawaited(model.initialize());
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
    final pages = [const ShopHome(), CartPage(onBrowse: () => setState(() => current = 0)), const OrdersPage(), const AccountPage()];
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
List<String> productImageGallery(Map<String,dynamic> product) {
  final rawImages = product['images'];
  if (rawImages is List) {
    final gallery = rawImages.whereType<Map>().map((image)=>textOf(image['url'])).where((url)=>url.isNotEmpty).toList();
    if (gallery.isNotEmpty) return gallery;
  }
  final primary = textOf(product['imageUrl']);
  return primary.isEmpty ? const <String>[] : <String>[primary];
}

class ShopHome extends StatefulWidget {
  const ShopHome({super.key});
  @override
  State<ShopHome> createState() => _ShopHomeState();
}
class _ShopHomeState extends State<ShopHome> {
  String category = 'all';
  String query = '';
  Timer? _searchDebounce;

  @override
  void dispose() {
    _searchDebounce?.cancel();
    super.dispose();
  }

  void _selectCategory(ShopState model, String value) {
    setState(() => category = value);
    unawaited(model.loadProducts(category: value, search: query));
  }

  @override
  Widget build(BuildContext context) {
    final model = ShopScope.of(context);
    final products = model.products;
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
              onChanged:(value){
                setState(()=>query=value);
                _searchDebounce?.cancel();
                _searchDebounce=Timer(const Duration(milliseconds:350),()=>model.loadProducts(category:category,search:value));
              },
              decoration:InputDecoration(
                prefixIcon:const Icon(Icons.search),
                hintText:'Search products...',
                border:const OutlineInputBorder(),
                suffixIcon:query.isEmpty?null:IconButton(icon:const Icon(Icons.close),onPressed:(){
                  setState(()=>query='');
                  _searchDebounce?.cancel();
                  unawaited(model.loadProducts(category:category,search:''));
                }),
              ),
            ),
          ),
          const Padding(padding:EdgeInsets.fromLTRB(16,7,16,10),child:Row(children:[Text('Explore categories',style:TextStyle(fontSize:19,fontWeight:FontWeight.w900,color:navy))])),
          SizedBox(height:45,child:ListView(scrollDirection:Axis.horizontal,padding:const EdgeInsets.symmetric(horizontal:16),children:[
            _categoryChip('all','All',category=='all',()=>_selectCategory(model,'all')),
            ...model.categories.map((c)=>_categoryChip(textOf(c['slug']),textOf(c['name']),category==c['slug'],()=>_selectCategory(model,textOf(c['slug'])))),
          ])),
          Padding(padding:const EdgeInsets.fromLTRB(16,24,16,14),child:Row(children:[
            Expanded(child:Text(query.isEmpty?'Find something you love':'Search results',style:const TextStyle(fontSize:19,fontWeight:FontWeight.w900,color:navy))),
            if(products.isNotEmpty)Text('${model.productsTotal} products',style:const TextStyle(fontSize:11,color:Colors.blueGrey,fontWeight:FontWeight.w700)),
          ])),
          if(model.error!=null) Padding(padding:const EdgeInsets.all(16),child:Column(children:[Text(model.error!,style:const TextStyle(color:Colors.red)),TextButton(onPressed:model.refresh,child:const Text('Retry'))])),
          if(model.loading)const LinearProgressIndicator(),
        ])),
        SliverPadding(
          padding:const EdgeInsets.fromLTRB(14,0,14,34),
          sliver:products.isEmpty&&!model.loading
              ? SliverToBoxAdapter(child:Padding(padding:const EdgeInsets.symmetric(vertical:42),child:Column(children:[
                  const Icon(Icons.search_off_rounded,size:48,color:Color(0xFF9AA9C0)),
                  const SizedBox(height:12),
                  Text(query.isEmpty?'No products in this category yet':'No products match “$query”',textAlign:TextAlign.center,style:const TextStyle(color:navy,fontWeight:FontWeight.w800)),
                  if(query.isNotEmpty)TextButton(onPressed:(){setState(()=>query='');unawaited(model.loadProducts(category:category,search:''));},child:const Text('Clear search')),
                ])))
              : SliverGrid.builder(
                  itemCount:products.length,
                  gridDelegate:const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount:2,mainAxisSpacing:13,crossAxisSpacing:13,childAspectRatio:.69),
                  itemBuilder:(context,i){final p=products[i];return ProductTile(product:p,onView:()=>showProductQuickView(context,p),onAdd:(){if(productVariantsOf(p).isNotEmpty){showProductQuickView(context,p);return;}model.add(textOf(p['id']));ScaffoldMessenger.of(context).showSnackBar(SnackBar(content:Text('${p['name']} added to cart'),duration:const Duration(seconds:1)));});},
                ),
        ),
        if(model.productsHasMore||model.loadingMoreProducts)
          SliverToBoxAdapter(child:Padding(padding:const EdgeInsets.fromLTRB(20,0,20,30),child:Center(child:OutlinedButton.icon(
            onPressed:model.loadingMoreProducts?null:()=>model.loadProducts(append:true),
            icon:model.loadingMoreProducts?const SizedBox(width:17,height:17,child:CircularProgressIndicator(strokeWidth:2)):const Icon(Icons.expand_more),
            label:Text(model.loadingMoreProducts?'Loading more products…':'Load more products'),
          )))),
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
  const ProductTile({super.key,required this.product,required this.onAdd,required this.onView});
  final Map<String,dynamic> product;
  final VoidCallback onAdd;
  final VoidCallback onView;
  @override
  Widget build(BuildContext context) => Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(17),
          boxShadow: [BoxShadow(color: const Color(0x0E081F62), blurRadius: 14, offset: const Offset(0, 5))],
        ),
        clipBehavior: Clip.antiAlias,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: onView,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                child: Stack(fit: StackFit.expand, children: [
                  productImage(textOf(product['imageUrl'])),
                  if (product['isSecondHand'] == true)
                    Positioned(
                      left: 8,
                      bottom: 8,
                      child: _quickViewBadge('PRE-OWNED', const Color(0xFFFFF8E8), const Color(0xFF82561A)),
                    ),
                  Positioned(
                    right: 8,
                    top: 8,
                    child: DecoratedBox(
                      decoration: BoxDecoration(color: Colors.white.withOpacity(.92), borderRadius: BorderRadius.circular(99)),
                      child: const Padding(
                        padding: EdgeInsets.symmetric(horizontal: 9, vertical: 6),
                        child: Text('Quick view  ↗', style: TextStyle(fontSize: 9, fontWeight: FontWeight.w800, color: blue)),
                      ),
                    ),
                  ),
                ]),
              ),
              Padding(
                padding: const EdgeInsets.all(11),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(textOf(product['category']).toUpperCase(), style: const TextStyle(fontSize: 9, letterSpacing: .7, color: Colors.blueGrey, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 5),
                  Text(textOf(product['name']), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 14, color: navy)),
                  const SizedBox(height: 8),
                  Row(children: [
                    Expanded(child: Text('${productVariantsOf(product).isNotEmpty ? 'From ' : ''}${money(product['price'])}', maxLines: 1, style: const TextStyle(color: blue, fontWeight: FontWeight.w900, fontSize: 13))),
                    SizedBox(
                      width: 33,
                      height: 33,
                      child: IconButton.filledTonal(
                        icon: const Icon(Icons.add, size: 20),
                        padding: EdgeInsets.zero,
                        onPressed: product['active'] == false || (product['trackInventory'] == true && countOf(product['stock']) <= 0) ? null : onAdd,
                      ),
                    ),
                  ]),
                ]),
              ),
            ]),
          ),
        ),
      );
}

Future<void> showProductQuickView(BuildContext context, Map<String,dynamic> product) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) => _ProductQuickViewSheet(initialProduct: product, pageContext: context),
    );

class _ProductQuickViewSheet extends StatefulWidget {
  const _ProductQuickViewSheet({required this.initialProduct, required this.pageContext});
  final Map<String, dynamic> initialProduct;
  final BuildContext pageContext;

  @override
  State<_ProductQuickViewSheet> createState() => _ProductQuickViewSheetState();
}

class _ProductQuickViewSheetState extends State<_ProductQuickViewSheet> {
  late Map<String, dynamic> product;
  String selectedVariantId = '';
  int selectedImageIndex = 0;
  int quantity = 1;
  bool loadingDetails = true;

  @override
  void initState() {
    super.initState();
    product = Map<String, dynamic>.from(widget.initialProduct);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_loadLatestProduct());
    });
  }

  Future<void> _loadLatestProduct() async {
    final id = textOf(product['id']);
    if (id.isEmpty) {
      if (mounted) setState(() => loadingDetails = false);
      return;
    }
    try {
      final response = await ShopScope.of(context).request('/products/${Uri.encodeComponent(id)}');
      if (mounted && response['product'] is Map) {
        setState(() => product = Map<String, dynamic>.from(response['product']));
      }
    } catch (_) {
      // Keep the live catalog card visible if detail refresh is temporarily unavailable.
    } finally {
      if (mounted) setState(() => loadingDetails = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final model = ShopScope.of(context);
    final images = productImageGallery(product);
    final variants = productVariantsOf(product);
    final selectedVariant = variants.where((option) => textOf(option['id']) == selectedVariantId).firstOrNull;
    final price = countOf(selectedVariant?['price'] ?? product['price']);
    final stock = countOf(product['stock']);
    final tracksInventory = product['trackInventory'] == true;
    final productAvailable = product['active'] != false && (!tracksInventory || stock > 0);
    final limit = tracksInventory ? stock.clamp(0, 100).toInt() : 100;
    final addable = (limit - model.quantityForProduct(textOf(product['id']))).clamp(0, limit).toInt();
    final categorySlug = textOf(product['categorySlug']);
    final relatedProducts = model.products.where((item) =>
      textOf(item['id']) != textOf(product['id']) && item['active'] != false &&
      categorySlug.isNotEmpty && textOf(item['categorySlug']) == categorySlug).take(6).toList();
    if (quantity > addable && addable > 0) quantity = addable;
    if (addable == 0) quantity = 0;

    return Container(
      height: MediaQuery.sizeOf(context).height * .91,
      decoration: const BoxDecoration(color: Colors.white, borderRadius: BorderRadius.vertical(top: Radius.circular(28))),
      child: Column(children: [
        Padding(padding: const EdgeInsets.only(top: 11, bottom: 4), child: Container(width: 42, height: 4, decoration: BoxDecoration(color: const Color(0xFFDCE3EE), borderRadius: BorderRadius.circular(9)))),
        Expanded(child: SingleChildScrollView(padding: const EdgeInsets.fromLTRB(17, 10, 17, 22), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          ClipRRect(borderRadius: BorderRadius.circular(22), child: Container(
            height: 280,
            color: const Color(0xFFF2F5FB),
            child: Stack(children: [
              Positioned.fill(child: Padding(padding: const EdgeInsets.all(13), child: productImage(images.isEmpty ? '' : images[selectedImageIndex.clamp(0, images.length - 1).toInt()], fit: BoxFit.contain))),
              if (product['isSecondHand'] == true) Positioned(left: 13, top: 13, child: _quickViewBadge('PRE-OWNED', const Color(0xFFFFF4D9), const Color(0xFF82561A))),
              if (loadingDetails) const Positioned(left: 0, right: 0, bottom: 0, child: LinearProgressIndicator(minHeight: 2)),
              Positioned(right: 10, top: 10, child: Material(color: Colors.white.withOpacity(.94), shape: const CircleBorder(), child: IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close, color: navy)))),
              if (images.length > 1) Positioned(left: 0, right: 0, bottom: 11, child: SizedBox(height: 55, child: ListView.separated(
                padding: const EdgeInsets.symmetric(horizontal: 12), scrollDirection: Axis.horizontal, itemCount: images.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (context, index) => InkWell(onTap: () => setState(() => selectedImageIndex = index), borderRadius: BorderRadius.circular(11), child: Container(
                  width: 55, padding: const EdgeInsets.all(3), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(11), border: Border.all(color: selectedImageIndex == index ? blue : const Color(0xFFE1E7F0), width: selectedImageIndex == index ? 2 : 1)),
                  child: ClipRRect(borderRadius: BorderRadius.circular(8), child: productImage(images[index], fit: BoxFit.contain)),
                )),
              ))),
            ]),
          )),
          const SizedBox(height: 17),
          Text(textOf(product['category']).toUpperCase(), style: const TextStyle(color: blue, fontWeight: FontWeight.w900, fontSize: 10, letterSpacing: 1.2)),
          const SizedBox(height: 5),
          Text(textOf(product['name']), style: const TextStyle(color: navy, fontWeight: FontWeight.w900, fontSize: 24, height: 1.12)),
          const SizedBox(height: 9),
          Text(variants.isNotEmpty ? 'From ${money(product['price'])}' : money(price), style: const TextStyle(color: blue, fontWeight: FontWeight.w900, fontSize: 21)),
          const SizedBox(height: 10),
          Text(textOf(product['description']).isEmpty ? 'A quality everyday find, selected for you.' : textOf(product['description']), style: const TextStyle(height: 1.5, color: Color(0xFF52627B))),
          if (variants.isNotEmpty) ...[
            const SizedBox(height: 19),
            Row(children: [const Expanded(child: Text('Choose your option', style: TextStyle(color: navy, fontWeight: FontWeight.w900, fontSize: 15))), Text('${variants.length} options', style: const TextStyle(color: Colors.blueGrey, fontSize: 11, fontWeight: FontWeight.w700))]),
            const SizedBox(height: 9),
            Wrap(spacing: 8, runSpacing: 8, children: variants.map((option) {
              final id = textOf(option['id']);
              final chosen = id == selectedVariantId;
              return ChoiceChip(
                label: Text('${textOf(option['type'])}: ${textOf(option['value'])}  ·  ${money(option['price'])}'),
                selected: chosen,
                onSelected: (value) => setState(() => selectedVariantId = value ? id : ''),
                selectedColor: const Color(0xFFEAF1FF),
                side: BorderSide(color: chosen ? blue : const Color(0xFFE2E8F2)),
                labelStyle: TextStyle(color: chosen ? blue : navy, fontSize: 11, fontWeight: FontWeight.w800),
              );
            }).toList()),
          ],
          const SizedBox(height: 16),
          Container(padding: const EdgeInsets.all(13), decoration: BoxDecoration(color: const Color(0xFFF6F8FC), borderRadius: BorderRadius.circular(15)), child: Row(children: [
            Icon(productAvailable ? Icons.verified_rounded : Icons.remove_shopping_cart, color: productAvailable ? const Color(0xFF188653) : Colors.red, size: 20),
            const SizedBox(width: 9),
            Expanded(child: Text(!productAvailable ? 'Currently unavailable' : tracksInventory ? (stock < 6 ? 'Only $stock left' : 'Available now') : 'Available now', style: TextStyle(fontWeight: FontWeight.w800, color: productAvailable ? const Color(0xFF188653) : Colors.red))),
            if (product['isSecondHand'] == true) _quickViewBadge('PRE-OWNED', const Color(0xFFFFF4D9), const Color(0xFF82561A)),
          ])),
          if (relatedProducts.isNotEmpty) ...[
            const SizedBox(height: 22),
            const Text('You may also like', style: TextStyle(color: navy, fontWeight: FontWeight.w900, fontSize: 16)),
            const SizedBox(height: 10),
            SizedBox(height: 148, child: ListView.separated(scrollDirection: Axis.horizontal, itemCount: relatedProducts.length, separatorBuilder: (_, __) => const SizedBox(width: 10), itemBuilder: (context, index) {
              final related = relatedProducts[index];
              return SizedBox(
                width: 118,
                child: Material(
                  color: const Color(0xFFF6F8FC),
                  borderRadius: BorderRadius.circular(14),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(14),
                    onTap: () {
                      Navigator.pop(context);
                      WidgetsBinding.instance.addPostFrameCallback((_) {
                        if (widget.pageContext.mounted) unawaited(showProductQuickView(widget.pageContext, related));
                      });
                    },
                    child: Padding(
                      padding: const EdgeInsets.all(9),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Expanded(child: Center(child: productImage(textOf(related['imageUrl']), fit: BoxFit.contain))),
                        Text(textOf(related['name']), maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: navy, fontWeight: FontWeight.w800, fontSize: 11)),
                        const SizedBox(height: 3),
                        Text(money(related['price']), style: const TextStyle(color: blue, fontWeight: FontWeight.w900, fontSize: 11)),
                      ]),
                    ),
                  ),
                ),
              );
            })),
          ],
        ]))),
        Container(decoration: BoxDecoration(color: Colors.white, boxShadow: [BoxShadow(color: navy.withOpacity(.08), blurRadius: 15, offset: const Offset(0, -4))]), padding: const EdgeInsets.fromLTRB(17, 11, 17, 12), child: SafeArea(top: false, child: Row(children: [
          Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [const Text('YOUR TOTAL', style: TextStyle(color: Colors.blueGrey, fontSize: 9, letterSpacing: .7, fontWeight: FontWeight.w800)), Text(money(price * quantity), style: const TextStyle(color: navy, fontSize: 17, fontWeight: FontWeight.w900))]),
          const SizedBox(width: 9),
          IconButton.filledTonal(onPressed: quantity > 1 ? () => setState(() => quantity--) : null, icon: const Icon(Icons.remove)),
          Text('$quantity', style: const TextStyle(color: navy, fontWeight: FontWeight.w900)),
          IconButton.filledTonal(onPressed: quantity < addable ? () => setState(() => quantity++) : null, icon: const Icon(Icons.add)),
          const SizedBox(width: 4),
          Expanded(child: FilledButton.icon(
            onPressed: productAvailable && addable > 0 && (variants.isEmpty || selectedVariant != null) ? () {
              model.add(textOf(product['id']), quantity, selectedVariantId);
              final optionLabel = selectedVariant == null ? '' : ' · ${textOf(selectedVariant['type'])}: ${textOf(selectedVariant['value'])}';
              Navigator.pop(context);
              ScaffoldMessenger.of(widget.pageContext).showSnackBar(SnackBar(content: Text('$quantity × ${textOf(product['name'])}$optionLabel added to cart'), duration: const Duration(seconds: 2)));
            } : null,
            icon: const Icon(Icons.shopping_bag_outlined),
            label: Text(variants.isNotEmpty && selectedVariant == null ? 'Choose option' : addable == 0 ? 'In cart' : 'Add to cart'),
          )),
        ]))),
      ]),
    );
  }
}

Widget _quickViewBadge(String label, Color background, Color foreground) => DecoratedBox(
  decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(99)),
  child: Padding(padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6), child: Text(label, style: TextStyle(color: foreground, fontSize: 9, fontWeight: FontWeight.w900, letterSpacing: .3))),
);

class CartPage extends StatelessWidget {
  const CartPage({super.key, this.onBrowse});
  final VoidCallback? onBrowse;
  @override
  Widget build(BuildContext context) {
    final model=ShopScope.of(context);
    final items=model.cartProducts;
    return Column(children:[
      Container(margin:const EdgeInsets.fromLTRB(16,14,16,12),padding:const EdgeInsets.all(18),decoration:BoxDecoration(gradient:const LinearGradient(colors:[navy,blue]),borderRadius:BorderRadius.circular(20)),child:Row(children:[
        Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[const Text('YOUR BAG',style:TextStyle(color:gold,fontWeight:FontWeight.w900,fontSize:10,letterSpacing:1.2)),const SizedBox(height:5),const Text('Your cart',style:TextStyle(color:Colors.white,fontSize:23,fontWeight:FontWeight.w900)),const SizedBox(height:3),Text('${model.cartCount} ${model.cartCount==1?'item':'items'} ready for checkout',style:const TextStyle(color:Color(0xFFDDE9FF),fontSize:12))])),
        Container(width:48,height:48,decoration:BoxDecoration(color:Colors.white.withOpacity(.14),borderRadius:BorderRadius.circular(15)),child:const Icon(Icons.shopping_bag_outlined,color:gold,size:25)),
      ])),
      if(model.cartIssues.isNotEmpty)Padding(padding:const EdgeInsets.fromLTRB(16,0,16,8),child:Container(padding:const EdgeInsets.all(12),decoration:BoxDecoration(color:const Color(0xFFFFF7DA),borderRadius:BorderRadius.circular(14),border:Border.all(color:const Color(0xFFF0D992))),child:Row(children:[const Icon(Icons.info_outline,color:Color(0xFF8A6412)),const SizedBox(width:9),const Expanded(child:Text('Some items are unavailable or need attention before checkout.',style:TextStyle(fontSize:12))),TextButton(onPressed:model.reconcileCart,child:const Text('Update'))]))),
      Expanded(child:items.isEmpty?Center(child:Padding(padding:const EdgeInsets.all(28),child:Column(mainAxisSize:MainAxisSize.min,children:[
        Container(width:94,height:94,decoration:const BoxDecoration(color:Color(0xFFEAF1FF),shape:BoxShape.circle),child:const Icon(Icons.shopping_bag_outlined,size:43,color:blue)),
        const SizedBox(height:17),const Text('Your cart is waiting',style:TextStyle(fontWeight:FontWeight.w900,fontSize:20,color:navy)),
        const SizedBox(height:7),const Text('Explore the store and add something you love.',textAlign:TextAlign.center,style:TextStyle(color:Colors.blueGrey)),
        const SizedBox(height:18),FilledButton.icon(onPressed:onBrowse,icon:const Icon(Icons.storefront_outlined),label:const Text('Browse the shop')),
      ]))):ListView.builder(padding:const EdgeInsets.fromLTRB(16,0,16,14),itemCount:items.length,itemBuilder:(context,index){
        final p=items[index];final id=textOf(p['_cartKey']);final option=textOf(p['_variantLabel']);
        return Container(margin:const EdgeInsets.only(bottom:11),padding:const EdgeInsets.all(10),decoration:BoxDecoration(color:Colors.white,borderRadius:BorderRadius.circular(17),border:Border.all(color:const Color(0xFFE8EDF5)),boxShadow:[BoxShadow(color:navy.withOpacity(.035),blurRadius:12,offset:const Offset(0,4))]),child:Row(crossAxisAlignment:CrossAxisAlignment.start,children:[
          ClipRRect(borderRadius:BorderRadius.circular(13),child:Container(width:91,height:104,color:const Color(0xFFF2F5FB),child:productImage(textOf(p['imageUrl']),fit:BoxFit.contain))),
          const SizedBox(width:12),Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
            Text(textOf(p['name']),maxLines:2,overflow:TextOverflow.ellipsis,style:const TextStyle(fontWeight:FontWeight.w900,color:navy,fontSize:14)),
            if(option.isNotEmpty)Padding(padding:const EdgeInsets.only(top:5),child:Text(option,style:const TextStyle(color:Colors.blueGrey,fontSize:11,fontWeight:FontWeight.w700))),
            if(p['isSecondHand']==true)Padding(padding:const EdgeInsets.only(top:5),child:_quickViewBadge('PRE-OWNED',const Color(0xFFFFF4D9),const Color(0xFF82561A))),
            const SizedBox(height:7),Text(money(p['_linePrice']),style:const TextStyle(color:blue,fontWeight:FontWeight.w900,fontSize:15)),
            Row(children:[_cartQuantityButton(Icons.remove,()=>model.changeQuantity(id,-1)),Padding(padding:const EdgeInsets.symmetric(horizontal:9),child:Text('${model.cart[id]}',style:const TextStyle(color:navy,fontWeight:FontWeight.w900))),_cartQuantityButton(Icons.add,()=>model.changeQuantity(id,1)),const Spacer(),IconButton(tooltip:'Remove item',onPressed:()=>model.changeQuantity(id,-model.cart[id]!),icon:const Icon(Icons.delete_outline,color:Colors.blueGrey,size:20))]),
          ])),
        ]));
      })),
      Container(padding:const EdgeInsets.fromLTRB(18,14,18,13),decoration:BoxDecoration(color:Colors.white,boxShadow:[BoxShadow(color:navy.withOpacity(.07),blurRadius:15,offset:const Offset(0,-4))]),child:SafeArea(top:false,child:Column(children:[
        Row(children:[const Expanded(child:Text('Subtotal',style:TextStyle(color:navy,fontWeight:FontWeight.w800))),Text(money(model.subtotal),style:const TextStyle(fontSize:20,fontWeight:FontWeight.w900,color:blue))]),
        const SizedBox(height:4),const Row(children:[Icon(Icons.receipt_long_outlined,size:14,color:Colors.blueGrey),SizedBox(width:6),Expanded(child:Text('Delivery and taxes are confirmed before you place the order.',style:TextStyle(fontSize:10,color:Colors.blueGrey)))]),
        const SizedBox(height:13),SizedBox(width:double.infinity,child:FilledButton.icon(onPressed:model.cartCount==0||model.cartIssues.isNotEmpty?null:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>const CheckoutPage())),icon:const Icon(Icons.lock_outline),label:const Text('Secure checkout  →'))),
      ]))),
    ]);
  }
}

Widget _cartQuantityButton(IconData icon, VoidCallback onPressed) => SizedBox(width:32,height:32,child:IconButton.filledTonal(onPressed:onPressed,padding:EdgeInsets.zero,visualDensity:VisualDensity.compact,icon:Icon(icon,size:17)));

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});
  @override
  State<LoginPage> createState()=>_LoginPageState();
}
class _LoginPageState extends State<LoginPage> {
  final form=GlobalKey<FormState>();
  final name=TextEditingController(),email=TextEditingController(),password=TextEditingController(),totp=TextEditingController();
  bool register=false,busy=false;
  bool mfaRequired=false;
  String? error;
  @override
  void dispose(){name.dispose();email.dispose();password.dispose();totp.dispose();super.dispose();}
  @override
  Widget build(BuildContext context) {
    final model=ShopScope.of(context);
    return Scaffold(
    appBar:AppBar(title:const Text('Your IwacuMall account')),
    body:SingleChildScrollView(padding:const EdgeInsets.all(23),child:Form(key:form,child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
      const SizedBox(height:15),Center(child:Image.asset('assets/logo.png',width:115,height:115)),const SizedBox(height:20),
      Text(register?'Join IwacuMall':'Welcome back',textAlign:TextAlign.center,style:const TextStyle(fontSize:26,fontWeight:FontWeight.w900,color:navy)),
      const SizedBox(height:25),
      Container(padding:const EdgeInsets.all(17),decoration:BoxDecoration(gradient:const LinearGradient(colors:[navy,blue]),borderRadius:BorderRadius.circular(20)),child:Row(children:[
        Container(width:47,height:47,decoration:BoxDecoration(color:Colors.white.withOpacity(.14),borderRadius:BorderRadius.circular(14)),child:const Icon(Icons.verified_user_outlined,color:gold)),
        const SizedBox(width:12),const Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text('Shop with confidence',style:TextStyle(color:Colors.white,fontWeight:FontWeight.w900,fontSize:15)),SizedBox(height:4),Text('Your orders and details stay in sync.',style:TextStyle(color:Color(0xFFDDE9FF),fontSize:11))])),
      ])),
      const SizedBox(height:19),
      OutlinedButton.icon(onPressed:busy?null:signInWithGoogle,icon:const Text('G',style:TextStyle(color:blue,fontSize:19,fontWeight:FontWeight.w900)),label:Text(busy?'Connecting to Google…':'Continue with Google'),style:OutlinedButton.styleFrom(minimumSize:const Size.fromHeight(51),foregroundColor:navy,side:const BorderSide(color:Color(0xFFDDE4F0)),shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(14)))),
      const Padding(padding:EdgeInsets.symmetric(vertical:14),child:Row(children:[Expanded(child:Divider()),Padding(padding:EdgeInsets.symmetric(horizontal:12),child:Text('or use your email',style:TextStyle(color:Colors.blueGrey,fontSize:12))),Expanded(child:Divider())])),
      if(register)...[TextFormField(controller:name,decoration:const InputDecoration(labelText:'Full name'),validator:(v)=>(v??'').trim().length<2?'Please enter your name':null),const SizedBox(height:14)],
      TextFormField(controller:email,keyboardType:TextInputType.emailAddress,decoration:const InputDecoration(labelText:'Email address'),validator:(v)=>(v??'').contains('@')?null:'Enter a valid email'),const SizedBox(height:14),
      TextFormField(controller:password,obscureText:true,decoration:const InputDecoration(labelText:'Password'),validator:(v)=>(v??'').length<(register?10:1)?'Password is too short':null),
      if(mfaRequired)TextFormField(controller:totp,decoration:const InputDecoration(labelText:'Authenticator or recovery code'),validator:(v){final code=(v??'').trim();return code.length==6||code.length==16?null:'Enter a six-digit code or 16-character recovery code';}),
      if(error!=null)Padding(padding:const EdgeInsets.only(top:15),child:Text(error!,style:const TextStyle(color:Colors.red))),
      const SizedBox(height:23),FilledButton(onPressed:busy?null:submit,child:Text(busy?'Please wait...':register?'Create account':'Sign in')),
      if(!register)TextButton(onPressed:busy?null:requestPasswordReset,child:const Text('Forgot your password?')),
      TextButton(onPressed:()=>setState(()=>register=!register),child:Text(register?'Already have an account? Sign in':'New here? Create an account')),
    ]))),
  );
  }
  Future<void> submit() async {
    if(!form.currentState!.validate())return;
    setState(()=>busy=true);
    try{
      final authenticated=await ShopScope.of(context).authenticate(register:register,name:name.text,email:email.text,password:password.text,totpCode:totp.text.trim());
      if(!authenticated){setState(()=>mfaRequired=true);return;}
      if(mounted)Navigator.pop(context,true);
    }catch(e){setState(()=>error='$e');}finally{if(mounted)setState(()=>busy=false);}
  }
  Future<void> signInWithGoogle() async {
    setState(() { busy=true; error=null; });
    try {
      await ShopScope.of(context).authenticateWithGoogle();
      if(mounted)Navigator.pop(context,true);
    } catch(e) {
      if(mounted)setState(()=>error='Google sign-in failed: $e');
    } finally { if(mounted)setState(()=>busy=false); }
  }
  Future<void> requestPasswordReset() async {
    if (email.text.trim().isEmpty) { setState(()=>error='Enter your email address first.'); return; }
    setState(()=>busy=true);
    try {
      final result=await ShopScope.of(context).request('/auth/forgot-password',method:'POST',body:{'email':email.text.trim()});
      if(!mounted)return;
      await showDialog<void>(context:context,builder:(c)=>AlertDialog(title:const Text('Check your email'),content:Text(textOf(result['message'])),actions:[TextButton(onPressed:()=>Navigator.pop(c),child:const Text('OK'))]));
    } catch(e) { if(mounted)setState(()=>error='$e'); }
    finally { if(mounted)setState(()=>busy=false); }
  }
}

class CheckoutPage extends StatefulWidget {
  const CheckoutPage({super.key});
  @override
  State<CheckoutPage> createState()=>_CheckoutPageState();
}
class _CheckoutPageState extends State<CheckoutPage> {
  final form=GlobalKey<FormState>();
  final name=TextEditingController(),email=TextEditingController(),phone=TextEditingController(),city=TextEditingController(text:'Kigali'),address=TextEditingController(),note=TextEditingController();
  List<Map<String, dynamic>> savedAddresses = [];
  String? selectedSavedAddress;
  bool addressLookupStarted = false;
  bool busy=false;
  String? error;
  String? paymentMethodId;
  @override
  void didChangeDependencies(){
    super.didChangeDependencies();
    final model = ShopScope.of(context);
    if(name.text.isEmpty)name.text=textOf(model.user?['name']);
    if(email.text.isEmpty)email.text=textOf(model.user?['email']);
    if(model.signedIn && !addressLookupStarted){
      addressLookupStarted = true;
      unawaited(model.request('/me/addresses').then((result){
        if(!mounted)return;
        final loaded = (result['addresses'] as List? ?? []).map((item)=>Map<String,dynamic>.from(item)).toList();
        setState(()=>savedAddresses=loaded);
        final preferred = loaded.where((item)=>item['isDefault']==true).firstOrNull ?? loaded.firstOrNull;
        if(preferred!=null)selectAddress(textOf(preferred['id']));
      }).catchError((_){ }));
    }
  }
  void selectAddress(String id){
    final item = savedAddresses.where((address)=>address['id']==id).firstOrNull;
    if(item==null)return;
    setState(()=>selectedSavedAddress=id);
    name.text=textOf(item['recipientName']);
    phone.text=textOf(item['phone']);
    city.text=textOf(item['city']);
    address.text=textOf(item['address']);
  }
  @override
  void dispose(){name.dispose();email.dispose();phone.dispose();city.dispose();address.dispose();note.dispose();super.dispose();}
  @override
  Widget build(BuildContext context) {
    final model = ShopScope.of(context);
    final config = model.storeConfig;
    final methods = model.paymentMethods;
    final checkoutBlockedReason = textOf(config['checkoutBlockedReason']);
    paymentMethodId ??= methods.isNotEmpty ? textOf(methods.first['id']) : null;
    final configuredDelivery = countOf(config['deliveryFeeFlat']);
    final delivery = configuredDelivery < 0 ? 0 : configuredDelivery;
    final taxRate = countOf(config['taxRatePercent'] ?? -1);
    final tax = taxRate >= 0 ? (model.subtotal * taxRate / 100).round() : 0;
    final total = model.subtotal + delivery + tax;
    final enabled = config['checkoutEnabled'] == true && methods.isNotEmpty;
    return Scaffold(
      appBar: AppBar(title: const Text('Checkout')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16,12,16,28),
        child: Form(
          key: form,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(padding:const EdgeInsets.all(17),decoration:BoxDecoration(gradient:const LinearGradient(colors:[navy,blue]),borderRadius:BorderRadius.circular(20)),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
              const Text('ORDER SUMMARY',style:TextStyle(color:gold,fontSize:10,fontWeight:FontWeight.w900,letterSpacing:1.1)),
              const SizedBox(height:7),Text(money(total),style:const TextStyle(color:Colors.white,fontSize:27,fontWeight:FontWeight.w900)),
              const SizedBox(height:12),_checkoutSummary('Items subtotal',model.subtotal),_checkoutSummary('Delivery',delivery),if(taxRate>=0)_checkoutSummary('Tax · $taxRate%',tax),
              const Divider(color:Color(0x55FFFFFF),height:20),
              Row(children:[const Icon(Icons.receipt_long_outlined,color:gold,size:17),const SizedBox(width:7),Expanded(child:Text('Invoice payment · details shown after order',style:const TextStyle(color:Color(0xFFE5EDFF),fontSize:11,fontWeight:FontWeight.w700)))]),
            ])),
            const SizedBox(height:15),
            _CheckoutPanel(title:'Delivery details',subtitle:'Where should we bring your order?',icon:Icons.location_on_outlined,child:Column(children:[
              TextFormField(controller:name,decoration:const InputDecoration(labelText:'Full name'),validator:(v)=>(v??'').trim().length>=2?null:'Please enter your name'),
              const SizedBox(height:11),TextFormField(controller:email,keyboardType:TextInputType.emailAddress,autofillHints:const [AutofillHints.email],decoration:const InputDecoration(labelText:'Email for invoice and order updates'),validator:(v){final value=(v??'').trim();return RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(value)?null:'Enter a valid email address';}),
              if(savedAddresses.isNotEmpty) ...[
                const SizedBox(height:11),
                DropdownButtonFormField<String>(value:selectedSavedAddress,decoration:const InputDecoration(labelText:'Use a saved delivery address'),items:savedAddresses.map((item)=>DropdownMenuItem<String>(value:textOf(item['id']),child:Text('${textOf(item['label'])} · ${textOf(item['city'])}',overflow:TextOverflow.ellipsis))).toList(),onChanged:(value){if(value!=null)selectAddress(value);}),
              ],
              const SizedBox(height:11),TextFormField(controller:phone,keyboardType:TextInputType.phone,decoration:const InputDecoration(labelText:'Phone number'),validator:(v)=>(v??'').trim().length>=8?null:'Enter your phone number'),
              const SizedBox(height:11),TextFormField(controller:city,decoration:const InputDecoration(labelText:'City'),validator:(v)=>(v??'').trim().length>=2?null:'Enter your city'),
              const SizedBox(height:11),TextFormField(controller:address,decoration:const InputDecoration(labelText:'Street, building, landmark'),validator:(v)=>(v??'').trim().length>=5?null:'Enter your delivery address'),
            ])),
            const SizedBox(height:13),
            _CheckoutPanel(title:'Payment by invoice',subtitle:'Choose how you plan to pay.',icon:Icons.account_balance_wallet_outlined,child:Column(crossAxisAlignment:CrossAxisAlignment.stretch,children:[
              DropdownButtonFormField<String>(value:paymentMethodId,decoration:const InputDecoration(labelText:'Payment method'),items:methods.map((method)=>DropdownMenuItem<String>(value:textOf(method['id']),child:Text(textOf(method['label'])))).toList(),onChanged:(value)=>setState(()=>paymentMethodId=value),validator:(value)=>value==null?'Choose a payment method':null),
              const SizedBox(height:10),Container(padding:const EdgeInsets.all(12),decoration:BoxDecoration(color:const Color(0xFFEFF5FF),borderRadius:BorderRadius.circular(13)),child:Row(crossAxisAlignment:CrossAxisAlignment.start,children:[const Icon(Icons.info_outline,color:blue,size:18),const SizedBox(width:8),Expanded(child:Text(config['checkoutEnabled']==true?'Your order invoice will include the store payment instructions and account details.':checkoutBlockedReason.isEmpty?'Checkout is not available right now.':checkoutBlockedReason,style:const TextStyle(color:navy,fontSize:11,height:1.4)))])),
            ])),
            const SizedBox(height:13),
            _CheckoutPanel(title:'Anything else?',subtitle:'Add a delivery note if it helps.',icon:Icons.chat_bubble_outline,child:TextFormField(controller:note,maxLines:3,decoration:const InputDecoration(labelText:'Optional order note',hintText:'Apartment, gate, or delivery instructions')),
            ),
            if(error!=null)Padding(padding:const EdgeInsets.only(top:14),child:Container(padding:const EdgeInsets.all(12),decoration:BoxDecoration(color:const Color(0xFFFFEEEE),borderRadius:BorderRadius.circular(12)),child:Text(error!,style:const TextStyle(color:Colors.red,fontSize:12)))),
            const SizedBox(height:17),
            SizedBox(height:54,child:FilledButton.icon(onPressed:busy||!enabled||paymentMethodId==null?null:submit,icon:busy?const SizedBox(width:18,height:18,child:CircularProgressIndicator(strokeWidth:2,color:Colors.white)):const Icon(Icons.lock_outline),label:Text(busy?'Placing your order…':'Place order  ·  ${money(total)}'))),
            const SizedBox(height:9),const Text('Your order is sent securely to IwacuMall for confirmation.',textAlign:TextAlign.center,style:TextStyle(color:Colors.blueGrey,fontSize:10)),
          ]),
        ),
      ),
    );
  }
  Future<void> submit() async {
    if(!form.currentState!.validate())return;
    final model=ShopScope.of(context);
    if(model.cartIssues.isNotEmpty){setState(()=>error='Please update your cart to remove unavailable items or quantities.');return;}
    if(!model.signedIn){final result=await Navigator.push<bool>(context,MaterialPageRoute(builder:(_)=>const LoginPage()));if(result!=true||!mounted)return;if(email.text.trim().isEmpty)email.text=textOf(model.user?['email']);if(name.text.trim().isEmpty)name.text=textOf(model.user?['name']);}
    setState(()=>busy=true);
    try {
      final order = await model.placeOrder(
        customerName:name.text, customerEmail:email.text.trim(), phone:phone.text, city:city.text,
        address:address.text, note:note.text, paymentMethodId:paymentMethodId!,
      );
      if(!mounted)return;
      await showInvoiceDialog(context, order);
      if(mounted)Navigator.pop(context);
    } catch(e) { setState(()=>error='$e'); }
    finally { if(mounted)setState(()=>busy=false); }
  }
}

Widget _checkoutSummary(String label, dynamic amount) => Padding(
  padding: const EdgeInsets.symmetric(vertical: 3),
  child: Row(children: [Text(label,style:const TextStyle(color:Color(0xFFDDE9FF),fontSize:12)), const Spacer(), Text(money(amount), style: const TextStyle(color:Colors.white,fontWeight:FontWeight.w800,fontSize:12))]),
);

class _CheckoutPanel extends StatelessWidget {
  const _CheckoutPanel({required this.title, required this.subtitle, required this.icon, required this.child});
  final String title;
  final String subtitle;
  final IconData icon;
  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(15),
    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(18), border: Border.all(color: const Color(0xFFE7ECF4))),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [Container(width: 38,height: 38,decoration:BoxDecoration(color:const Color(0xFFEAF1FF),borderRadius:BorderRadius.circular(12)),child:Icon(icon,color:blue,size:20)),const SizedBox(width:10),Expanded(child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Text(title,style:const TextStyle(color:navy,fontWeight:FontWeight.w900,fontSize:14)),const SizedBox(height:2),Text(subtitle,style:const TextStyle(color:Colors.blueGrey,fontSize:10))]))]),
      const SizedBox(height:14),child,
    ]),
  );
}

Future<void> showInvoiceDialog(BuildContext context, Map<String, dynamic> order) => showDialog<void>(
  context: context,
  builder: (context) {
    final snapshot = Map<String, dynamic>.from(order['paymentMethodSnapshot'] as Map? ?? {});
    final label = textOf(snapshot['label'] ?? order['paymentMethodLabel']);
    final instructions = textOf(snapshot['instructions'] ?? order['paymentInstructions']);
    final accountName = textOf(snapshot['accountName']);
    final accountNumber = textOf(snapshot['accountNumber']);
    final deadline = textOf(order['paymentDeadline']);
    return AlertDialog(
      title: const Text('Invoice created'),
      content: SingleChildScrollView(child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Invoice ${textOf(order['invoiceNumber'])}', style: const TextStyle(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Text('Total due: ${money(order['total'])}', style: const TextStyle(fontSize: 18, color: blue, fontWeight: FontWeight.w900)),
          const SizedBox(height: 14),
          Text('Payment method: $label'),
          if (accountName.isNotEmpty) Text('Account name: $accountName'),
          if (accountNumber.isNotEmpty) Text('Account / number: $accountNumber'),
          const SizedBox(height: 8),
          Text(instructions),
          if (deadline.isNotEmpty) ...[const SizedBox(height: 12), Text('Pay by: $deadline')],
        ],
      )),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Done'))],
    );
  },
);

class OrdersPage extends StatefulWidget {
  const OrdersPage({super.key});
  @override
  State<OrdersPage> createState()=>_OrdersPageState();
}
class _OrdersPageState extends State<OrdersPage> {
  bool refreshing=false;
  final Set<String> sharingInvoices = {};
  final Set<String> sendingReturnRequests = {};
  @override
  void initState(){super.initState();WidgetsBinding.instance.addPostFrameCallback((_){if(mounted)load();});}
  Future<void> load() async {
    final model=ShopScope.of(context);
    if(!model.signedIn)return;
    setState(()=>refreshing=true);
    try{await model.loadOrders();}
    catch(e){if(mounted)ScaffoldMessenger.of(context).showSnackBar(SnackBar(content:Text('$e')));}
    finally{if(mounted)setState(()=>refreshing=false);}
  }
  Future<void> openInvoicePdf(Map<String, dynamic> order, String action) async {
    final id = textOf(order['id']);
    if (id.isEmpty || sharingInvoices.contains(id)) return;
    setState(() => sharingInvoices.add(id));
    try {
      final bytes = await ShopScope.of(context).fetchInvoicePdf(id);
      if (!mounted) return;
      final invoiceNumber = textOf(order['invoiceNumber']).isEmpty ? id.substring(0, id.length < 8 ? id.length : 8) : textOf(order['invoiceNumber']);
      await invoicePlatform.invokeMethod<void>('openPdf', {
        'bytes': bytes,
        'fileName': 'IwacuMall-invoice-$invoiceNumber.pdf',
        'action': action,
      });
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not open the invoice PDF: $error')));
    } finally {
      if (mounted) setState(() => sharingInvoices.remove(id));
    }
  }
  Future<void> loadMoreOrders() async {
    try {
      await ShopScope.of(context).loadMoreOrders();
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not load more orders: $error')));
    }
  }
  Future<void> requestReturn(Map<String,dynamic> order) async {
    final model=ShopScope.of(context);
    final policy=Map<String,dynamic>.from(order['returnPolicy'] as Map? ?? {});
    final remaining=((policy['remainingItems'] as List?) ?? [])
      .map((item)=>Map<String,dynamic>.from(item as Map)).toList();
    final selected=<String,int>{for(final item in remaining)textOf(item['productId']):0};
    final reason=TextEditingController();
    var dialogError='';
    final submitted=await showDialog<bool>(context:context,builder:(dialogContext)=>StatefulBuilder(builder:(context,setDialogState)=>AlertDialog(
      title:const Text('Request a return'),
      content:ConstrainedBox(constraints:BoxConstraints(maxHeight:MediaQuery.sizeOf(context).height*.6),child:SingleChildScrollView(child:Column(mainAxisSize:MainAxisSize.min,crossAxisAlignment:CrossAxisAlignment.stretch,children:[
        Text('Submit before ${textOf(policy['deadline']).split('T').first}. The store will review your request.',style:const TextStyle(color:Colors.blueGrey,fontSize:12)),
        const SizedBox(height:12),
        TextField(controller:reason,maxLength:500,maxLines:3,decoration:const InputDecoration(labelText:'Reason for return',border:OutlineInputBorder())),
        const SizedBox(height:10),
        ...remaining.map((item){
          final id=textOf(item['productId']);
          final maximum=countOf(item['availableQuantity']);
          return Padding(padding:const EdgeInsets.only(bottom:8),child:DropdownButtonFormField<int>(
            value:selected[id]??0,
            decoration:InputDecoration(labelText:'${textOf(item['productName'])} · quantity',border:const OutlineInputBorder()),
            items:List.generate(maximum+1,(quantity)=>DropdownMenuItem(value:quantity,child:Text('$quantity'))),
            onChanged:(quantity)=>setDialogState(()=>selected[id]=quantity??0),
          ));
        }),
        if(dialogError.isNotEmpty)Padding(padding:const EdgeInsets.only(top:6),child:Text(dialogError,style:const TextStyle(color:Colors.red,fontSize:12))),
      ]))),
      actions:[TextButton(onPressed:()=>Navigator.pop(dialogContext,false),child:const Text('Cancel')),FilledButton(onPressed:(){
        if(reason.text.trim().length<5){setDialogState(()=>dialogError='Please explain the reason in at least five characters.');return;}
        if(!selected.values.any((quantity)=>quantity>0)){setDialogState(()=>dialogError='Choose a quantity for at least one item.');return;}
        Navigator.pop(dialogContext,true);
      },child:const Text('Send request'))],
    )));
    if(submitted!=true||!mounted){reason.dispose();return;}
    final id=textOf(order['id']);
    setState(()=>sendingReturnRequests.add(id));
    try{
      final items=selected.entries.where((entry)=>entry.value>0).map((entry)=>{'productId':entry.key,'quantity':entry.value}).toList();
      await model.requestReturn(id,items,reason.text.trim());
      if(mounted)ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content:Text('Return request sent to the store')));
    }catch(error){
      if(mounted)ScaffoldMessenger.of(context).showSnackBar(SnackBar(content:Text('Could not send return request: $error')));
    }finally{
      reason.dispose();
      if(mounted)setState(()=>sendingReturnRequests.remove(id));
    }
  }
  @override
  Widget build(BuildContext context) {
    final model=ShopScope.of(context);
    return Column(children:[
      Padding(padding:const EdgeInsets.all(19),child:Row(children:[
        const Text('My orders',style:TextStyle(fontSize:25,fontWeight:FontWeight.w900,color:navy)),
        const Spacer(),IconButton(onPressed:load,icon:const Icon(Icons.refresh)),
      ])),
      Expanded(child:!model.signedIn
        ? Center(child:Column(mainAxisSize:MainAxisSize.min,children:[
            const Text('Sign in to track your orders'),const SizedBox(height:15),
            FilledButton(onPressed:()=>Navigator.push(context,MaterialPageRoute(builder:(_)=>const LoginPage())),child:const Text('Sign in')),
          ]))
        : refreshing ? const Center(child:CircularProgressIndicator())
        : model.orders.isEmpty ? const Center(child:Text('No orders yet. Enjoy shopping!'))
        : ListView.builder(
            padding:const EdgeInsets.fromLTRB(15,0,15,25),
            itemCount:model.orders.length+(model.ordersHasMore?1:0),
            itemBuilder:(context,i){
              if(i>=model.orders.length){
                return Padding(padding:const EdgeInsets.symmetric(vertical:12),child:Center(child:OutlinedButton.icon(
                  onPressed:model.loadingMoreOrders?null:loadMoreOrders,
                  icon:model.loadingMoreOrders?const SizedBox(width:16,height:16,child:CircularProgressIndicator(strokeWidth:2)):const Icon(Icons.expand_more),
                  label:Text(model.loadingMoreOrders?'Loading…':'Load older orders'),
                )));
              }
              final order=model.orders[i];
              final lines=(order['items'] as List?) ?? [];
              final fulfillment=textOf(order['fulfillmentStatus']??order['status']).replaceAll('_',' ');
              final payment=textOf(order['paymentStatus']).replaceAll('_',' ');
              final method=Map<String,dynamic>.from(order['paymentMethodSnapshot'] as Map? ?? {});
              final returnPolicy=Map<String,dynamic>.from(order['returnPolicy'] as Map? ?? {});
              final returnRequests=((order['returnRequests'] as List?) ?? [])
                .map((request)=>Map<String,dynamic>.from(request as Map)).toList();
              return Card(color:Colors.white,margin:const EdgeInsets.only(bottom:13),child:Padding(
                padding:const EdgeInsets.all(16),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
                  Row(children:[
                    Expanded(child:Text(textOf(order['invoiceNumber']).isEmpty?'Order #${textOf(order['id']).substring(0,8).toUpperCase()}':textOf(order['invoiceNumber']),style:const TextStyle(fontWeight:FontWeight.w900,color:navy))),
                    Chip(label:Text(fulfillment,style:const TextStyle(fontSize:10))),
                  ]),
                  Text('Payment: $payment · ${textOf(method['label']??order['paymentMethodLabel'])}',style:const TextStyle(color:Colors.blueGrey,fontSize:12)),
                  const SizedBox(height:5),
                  Text(money(order['total']),style:const TextStyle(color:blue,fontWeight:FontWeight.w900,fontSize:18)),
                  if (countOf(order['refundedAmount']) > 0) Text('Refunded ${money(order['refundedAmount'])} · ${textOf(order['refundStatus']).replaceAll('_', ' ').toLowerCase()}', style: const TextStyle(color: Color(0xFF8A4B00), fontSize: 12, fontWeight: FontWeight.w700)),
                  const Divider(height:24),
                  ...lines.map((item)=>Padding(padding:const EdgeInsets.only(bottom:5),child:Text('${item['productName']??item['product_name']} × ${item['quantity']}',style:const TextStyle(color:Colors.blueGrey,fontSize:12)))),
                  if(returnRequests.isNotEmpty)...[
                    const Divider(height:24),
                    ...returnRequests.map((request)=>Container(width:double.infinity,margin:const EdgeInsets.only(bottom:8),padding:const EdgeInsets.all(11),decoration:BoxDecoration(color:const Color(0xFFF5F8FD),borderRadius:BorderRadius.circular(12)),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[
                      Text('Return ${textOf(request['status']).replaceAll('_',' ').toLowerCase()}',style:const TextStyle(fontWeight:FontWeight.w800,color:navy)),
                      const SizedBox(height:4),
                      Text(textOf(request['reason']),style:const TextStyle(fontSize:12,color:Colors.blueGrey)),
                      if(textOf(request['reviewNote']).isNotEmpty)Padding(padding:const EdgeInsets.only(top:5),child:Text(textOf(request['reviewNote']),style:const TextStyle(fontSize:12,color:blue))),
                      ...(request['items'] as List? ?? []).map((item)=>Text('${item['productName']} × ${item['quantity']}${request['status']=='RECEIVED'?' · received ${item['returnedQuantity']??0}':''}',style:const TextStyle(fontSize:11,color:Colors.blueGrey))),
                    ]))),
                  ],
                  if(returnPolicy['canRequest']==true)Padding(padding:const EdgeInsets.only(top:8),child:OutlinedButton.icon(
                    onPressed:sendingReturnRequests.contains(textOf(order['id']))?null:()=>requestReturn(order),
                    icon:sendingReturnRequests.contains(textOf(order['id']))?const SizedBox(width:16,height:16,child:CircularProgressIndicator(strokeWidth:2)):const Icon(Icons.assignment_return_outlined),
                    label:Text(sendingReturnRequests.contains(textOf(order['id']))?'Sending request…':'Request a return'),
                  )),
                  Align(alignment:Alignment.centerLeft,child:TextButton.icon(
                    onPressed:()=>showInvoiceDialog(context, order),
                    icon:const Icon(Icons.receipt_long),label:const Text('Invoice and payment instructions'),
                  )),
                  Wrap(spacing: 8, children: [
                    TextButton.icon(
                      onPressed:sharingInvoices.contains(textOf(order['id']))?null:()=>openInvoicePdf(order, 'share'),
                      icon:sharingInvoices.contains(textOf(order['id']))?const SizedBox(width:17,height:17,child:CircularProgressIndicator(strokeWidth:2)):const Icon(Icons.share_outlined),
                      label:Text(sharingInvoices.contains(textOf(order['id']))?'Preparing PDF…':'Share PDF'),
                    ),
                    TextButton.icon(
                      onPressed:sharingInvoices.contains(textOf(order['id']))?null:()=>openInvoicePdf(order, 'open'),
                      icon:const Icon(Icons.print_outlined), label:const Text('Open / print PDF'),
                    ),
                  ]),
                ]),
              ));
            },
          ),
      ),
    ]);
  }
}

class AccountPage extends StatefulWidget {
  const AccountPage({super.key});
  @override
  State<AccountPage> createState() => _AccountPageState();
}

class _AccountPageState extends State<AccountPage> {
  List<Map<String, dynamic>> addresses = [];
  List<Map<String, dynamic>> sessions = [];
  bool addressesLoading = false;
  bool addressesLoaded = false;
  bool sessionsLoading = false;
  bool sessionsLoaded = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final model = ShopScope.of(context);
    if (model.signedIn && !addressesLoading && !addressesLoaded) {
      unawaited(loadAddresses());
    }
    if (model.signedIn && !sessionsLoading && !sessionsLoaded) {
      unawaited(loadSessions());
    }
    if (!model.signedIn && (addressesLoaded || sessionsLoaded)) {
      addresses = [];
      sessions = [];
      addressesLoaded = false;
      sessionsLoaded = false;
    }
  }

  Future<void> loadAddresses() async {
    if (!mounted || addressesLoading) return;
    setState(() => addressesLoading = true);
    try {
      final result = await ShopScope.of(context).request('/me/addresses');
      if (!mounted) return;
      setState(() {
        addresses = (result['addresses'] as List? ?? [])
            .map((item) => Map<String, dynamic>.from(item))
            .toList();
        addressesLoaded = true;
      });
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not load saved addresses: $error')));
      }
    } finally {
      if (mounted) setState(() => addressesLoading = false);
    }
  }

  Future<void> loadSessions() async {
    if (!mounted || sessionsLoading) return;
    setState(() => sessionsLoading = true);
    try {
      final result = await ShopScope.of(context).request('/me/sessions');
      if (!mounted) return;
      setState(() {
        sessions = (result['sessions'] as List? ?? [])
            .map((item) => Map<String, dynamic>.from(item))
            .toList();
        sessionsLoaded = true;
      });
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not load signed-in sessions: $error')));
    } finally {
      if (mounted) setState(() => sessionsLoading = false);
    }
  }

  Future<void> revokeSession(Map<String, dynamic> session) async {
    final id = textOf(session['id']);
    if (id.isEmpty || session['isCurrent'] == true) return;
    final shouldRevoke = await showDialog<bool>(context: context, builder: (dialogContext) => AlertDialog(
      title: const Text('Sign out this device?'),
      content: const Text('That device will need to sign in again to use this account.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Keep session')),
        FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Revoke session')),
      ],
    ));
    if (shouldRevoke != true) return;
    try {
      await ShopScope.of(context).request('/me/sessions/$id', method: 'DELETE');
      await loadSessions();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Session revoked.')));
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  Future<void> changePassword() async {
    final model = ShopScope.of(context);
    if (model.user?['googleLinked'] == true) {
      try {
        await model.request('/auth/forgot-password', method: 'POST', body: {'email': model.user?['email']});
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('If that address is registered, a password reset link will arrive shortly.')));
      } catch (error) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
      }
      return;
    }

    final current = TextEditingController();
    final next = TextEditingController();
    final confirm = TextEditingController();
    final formKey = GlobalKey<FormState>();
    final passwordData = await showDialog<Map<String, String>>(context: context, builder: (dialogContext) => AlertDialog(
      title: const Text('Change password'),
      content: Form(key: formKey, child: Column(mainAxisSize: MainAxisSize.min, children: [
        TextFormField(controller: current, obscureText: true, autofillHints: const [AutofillHints.password], decoration: const InputDecoration(labelText: 'Current password'), validator: (value) => (value ?? '').isEmpty ? 'Enter your current password' : null),
        TextFormField(controller: next, obscureText: true, decoration: const InputDecoration(labelText: 'New password'), validator: (value) => (value ?? '').length < 10 ? 'Use at least 10 characters' : null),
        TextFormField(controller: confirm, obscureText: true, decoration: const InputDecoration(labelText: 'Confirm new password'), validator: (value) => value != next.text ? 'Passwords do not match' : null),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
        FilledButton(onPressed: () {
          if (formKey.currentState?.validate() != true) return;
          Navigator.pop(dialogContext, {'currentPassword': current.text, 'newPassword': next.text});
        }, child: const Text('Update password')),
      ],
    ));
    current.dispose();
    next.dispose();
    confirm.dispose();
    if (passwordData == null) return;
    try {
      await model.request('/auth/change-password', method: 'POST', body: passwordData);
      await model.signOut(); // Password changes revoke every existing session.
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Password updated. Sign in again with your new password.')));
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  Future<void> deleteAccount() async {
    final model = ShopScope.of(context);
    if (model.user?['role'] == 'ADMIN') return;
    final confirmation = TextEditingController();
    final password = TextEditingController();
    final isGoogle = model.user?['googleLinked'] == true;
    final data = await showDialog<Map<String, String>>(context: context, builder: (dialogContext) => AlertDialog(
      title: const Text('Delete your account?'),
      content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('Your profile and saved addresses will be anonymized. Order records may be retained for store records.'),
        const SizedBox(height: 14),
        TextField(controller: confirmation, autocorrect: false, decoration: const InputDecoration(labelText: 'Type DELETE to confirm')),
        if (!isGoogle) TextField(controller: password, obscureText: true, decoration: const InputDecoration(labelText: 'Current password')),
      ])),
      actions: [
        TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(dialogContext, {'confirmation': confirmation.text, 'password': password.text}), child: const Text('Continue')),
      ],
    ));
    confirmation.dispose();
    password.dispose();
    if (data == null) return;
    if (data['confirmation'] != 'DELETE') {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Type DELETE exactly to confirm.')));
      return;
    }
    if (!isGoogle && (data['password'] ?? '').isEmpty) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Enter your current password to delete the account.')));
      return;
    }
    try {
      final idToken = isGoogle ? await model.acquireGoogleIdToken() : null;
      await model.request('/auth/delete-account', method: 'POST', body: {
        if (isGoogle) 'idToken': idToken,
        if (!isGoogle) 'password': data['password'],
      });
      await model.signOut();
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Your account was deleted.')));
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  Future<void> editName() async {
    final model = ShopScope.of(context);
    final controller = TextEditingController(text: textOf(model.user?['name']));
    final name = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Update your name'),
        content: TextField(controller: controller, autofocus: true, maxLength: 100, decoration: const InputDecoration(labelText: 'Full name')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
          FilledButton(onPressed: () {
            final value = controller.text.trim();
            if (value.length < 2) return;
            Navigator.pop(dialogContext, value);
          }, child: const Text('Save')),
        ],
      ),
    );
    controller.dispose();
    if (name == null) return;
    try {
      await model.updateProfileName(name);
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Profile updated.')));
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  Future<void> editAddress({Map<String, dynamic>? existing}) async {
    final model = ShopScope.of(context);
    final label = TextEditingController(text: textOf(existing?['label']));
    final recipient = TextEditingController(text: textOf(existing?['recipientName']).isEmpty ? textOf(model.user?['name']) : textOf(existing?['recipientName']));
    final phone = TextEditingController(text: textOf(existing?['phone']));
    final city = TextEditingController(text: textOf(existing?['city']).isEmpty ? 'Kigali' : textOf(existing?['city']));
    final address = TextEditingController(text: textOf(existing?['address']));
    final formKey = GlobalKey<FormState>();
    var isDefault = existing?['isDefault'] == true || existing == null && addresses.isEmpty;
    var saving = false;
    String? error;
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(builder: (dialogContext, setDialogState) => AlertDialog(
        title: Text(existing == null ? 'Add delivery address' : 'Edit delivery address'),
        content: SizedBox(width: 440, child: SingleChildScrollView(child: Form(
          key: formKey,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextFormField(controller: label, decoration: const InputDecoration(labelText: 'Label'), validator: (value) => (value ?? '').trim().length < 2 ? 'Enter a label' : null),
            TextFormField(controller: recipient, decoration: const InputDecoration(labelText: 'Recipient name'), validator: (value) => (value ?? '').trim().length < 2 ? 'Enter a name' : null),
            TextFormField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone number'), validator: (value) => (value ?? '').replaceAll(RegExp(r'\D'), '').length < 8 ? 'Enter a valid phone' : null),
            TextFormField(controller: city, decoration: const InputDecoration(labelText: 'City'), validator: (value) => (value ?? '').trim().length < 2 ? 'Enter a city' : null),
            TextFormField(controller: address, maxLines: 2, decoration: const InputDecoration(labelText: 'District, sector, street or landmark'), validator: (value) => (value ?? '').trim().length < 5 ? 'Enter the delivery address' : null),
            CheckboxListTile(contentPadding: EdgeInsets.zero, value: isDefault, title: const Text('Make this my default address'), onChanged: (value) => setDialogState(() => isDefault = value == true)),
            if (error != null) Align(alignment: Alignment.centerLeft, child: Text(error!, style: const TextStyle(color: Colors.red))),
          ]),
        ))),
        actions: [
          TextButton(onPressed: saving ? null : () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          FilledButton(onPressed: saving ? null : () async {
            if (!(formKey.currentState?.validate() ?? false)) return;
            setDialogState(() { saving = true; error = null; });
            final payload = {
              'label': label.text.trim(), 'recipientName': recipient.text.trim(),
              'phone': phone.text.trim(), 'city': city.text.trim(),
              'address': address.text.trim(), 'isDefault': isDefault,
            };
            try {
              final id = textOf(existing?['id']);
              await model.request(id.isEmpty ? '/me/addresses' : '/me/addresses/$id', method: id.isEmpty ? 'POST' : 'PATCH', body: payload);
              if (dialogContext.mounted) Navigator.pop(dialogContext, true);
            } catch (exception) {
              setDialogState(() { saving = false; error = '$exception'; });
            }
          }, child: Text(saving ? 'Saving…' : 'Save address')),
        ],
      )),
    );
    label.dispose(); recipient.dispose(); phone.dispose(); city.dispose(); address.dispose();
    if (saved == true) await loadAddresses();
  }

  Future<void> setDefaultAddress(String id) async {
    try {
      await ShopScope.of(context).request('/me/addresses/$id', method: 'PATCH', body: {'isDefault': true});
      await loadAddresses();
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  Future<void> removeAddress(String id) async {
    final shouldRemove = await showDialog<bool>(context: context, builder: (context) => AlertDialog(
      title: const Text('Remove address?'), content: const Text('This saved delivery address will be removed from your account.'),
      actions: [TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Keep it')), FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Remove'))],
    ));
    if (shouldRemove != true) return;
    try {
      await ShopScope.of(context).request('/me/addresses/$id', method: 'DELETE');
      await loadAddresses();
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final model = ShopScope.of(context);
    final storeAddress = textOf(model.storeConfig['storeAddress']);
    final storePhone = textOf(model.storeConfig['storePhone']);
    return ListView(padding: const EdgeInsets.fromLTRB(20, 24, 20, 30), children: [
      const Center(child: CircleAvatar(radius: 43, backgroundColor: Color(0xFFDFE9FF), child: Icon(Icons.person, size: 45, color: blue))),
      const SizedBox(height: 18),
      Text(model.signedIn ? 'Hello, ${model.user?['name'] ?? 'shopper'}' : 'Welcome to IwacuMall', textAlign: TextAlign.center, style: const TextStyle(fontSize: 25, color: navy, fontWeight: FontWeight.w900)),
      const SizedBox(height: 8),
      Text(model.user?['email'] ?? 'Your home of everything', textAlign: TextAlign.center, style: const TextStyle(color: Colors.blueGrey)),
      const SizedBox(height: 16),
      if (!model.signedIn)
        FilledButton(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const LoginPage())), child: const Text('Sign in / Register'))
      else ...[
        Wrap(alignment: WrapAlignment.center, spacing: 8, children: [
          OutlinedButton.icon(onPressed: editName, icon: const Icon(Icons.edit_outlined), label: const Text('Edit profile')),
          OutlinedButton.icon(onPressed: () async { await model.signOut(); }, icon: const Icon(Icons.logout), label: const Text('Sign out')),
        ]),
        if (model.user?['emailVerified'] == false) ...[
          const SizedBox(height: 8),
          const Text('Verify your email before placing orders.', textAlign: TextAlign.center, style: TextStyle(color: Colors.deepOrange)),
          TextButton(onPressed: () async {
            try {
              await model.request('/auth/resend-verification', method: 'POST', body: {});
              if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('If verification is needed, a fresh email was sent.')));
            } catch (error) { if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error'))); }
          }, child: const Text('Resend verification email')),
        ],
        const SizedBox(height: 22),
        Row(children: [
          const Expanded(child: Text('Saved delivery addresses', style: TextStyle(fontSize: 18, color: navy, fontWeight: FontWeight.w900))),
          TextButton.icon(onPressed: () => editAddress(), icon: const Icon(Icons.add), label: const Text('Add')),
        ]),
        if (addressesLoading && addresses.isEmpty) const Center(child: Padding(padding: EdgeInsets.all(18), child: CircularProgressIndicator()))
        else if (addresses.isEmpty) const Text('Save an address to speed up your next checkout.', style: TextStyle(color: Colors.blueGrey))
        else ...addresses.map((item) {
          final id = textOf(item['id']);
          return Card(color: Colors.white, margin: const EdgeInsets.only(bottom: 10), child: Padding(padding: const EdgeInsets.all(13), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [Expanded(child: Text('${textOf(item['label'])}${item['isDefault'] == true ? ' · DEFAULT' : ''}', style: const TextStyle(color: navy, fontWeight: FontWeight.w900))), if (item['isDefault'] != true) IconButton(tooltip: 'Make default', onPressed: () => setDefaultAddress(id), icon: const Icon(Icons.star_border))]),
            Text('${textOf(item['recipientName'])} · ${textOf(item['phone'])}\n${textOf(item['address'])}, ${textOf(item['city'])}', style: const TextStyle(color: Colors.blueGrey, height: 1.45)),
            Wrap(spacing: 8, children: [TextButton.icon(onPressed: () => editAddress(existing: item), icon: const Icon(Icons.edit_outlined), label: const Text('Edit')), TextButton.icon(onPressed: () => removeAddress(id), icon: const Icon(Icons.delete_outline), label: const Text('Remove'))]),
          ])));
        }),
        const SizedBox(height: 20),
        const Text('Security', style: TextStyle(fontSize: 18, color: navy, fontWeight: FontWeight.w900)),
        const SizedBox(height: 5),
        Text(model.user?['googleLinked'] == true ? 'This account uses Google. A password reset link can set a password for it.' : 'Changing your password signs out all your devices.', style: const TextStyle(color: Colors.blueGrey, fontSize: 12)),
        Align(alignment: Alignment.centerLeft, child: TextButton.icon(
          onPressed: changePassword,
          icon: const Icon(Icons.lock_reset_outlined),
          label: Text(model.user?['googleLinked'] == true ? 'Send password reset link' : 'Change password'),
        )),
        const SizedBox(height: 12),
        Row(children: [
          const Expanded(child: Text('Signed-in devices', style: TextStyle(fontSize: 17, color: navy, fontWeight: FontWeight.w900))),
          IconButton(tooltip: 'Refresh sessions', onPressed: loadSessions, icon: const Icon(Icons.refresh)),
        ]),
        if (sessionsLoading && sessions.isEmpty) const Center(child: Padding(padding: EdgeInsets.all(14), child: CircularProgressIndicator()))
        else if (sessions.isEmpty) const Text('No active sessions found.', style: TextStyle(color: Colors.blueGrey))
        else ...sessions.map((session) {
          final created = DateTime.tryParse(textOf(session['createdAt']))?.toLocal();
          final dateLabel = created == null ? 'Date unavailable' : '${created.year}-${created.month.toString().padLeft(2, '0')}-${created.day.toString().padLeft(2, '0')}';
          return Card(color: Colors.white, margin: const EdgeInsets.only(bottom: 8), child: ListTile(
            leading: Icon(session['isCurrent'] == true ? Icons.phone_android : Icons.devices_outlined, color: blue),
            title: Text(session['isCurrent'] == true ? 'This device' : 'Signed-in device', style: const TextStyle(fontWeight: FontWeight.w800)),
            subtitle: Text('Started $dateLabel'),
            trailing: session['isCurrent'] == true ? const Chip(label: Text('Current')) : IconButton(tooltip: 'Revoke session', onPressed: () => revokeSession(session), icon: const Icon(Icons.logout, color: Colors.redAccent)),
          ));
        }),
        if (model.user?['role'] != 'ADMIN') ...[
          const SizedBox(height: 22),
          const Text('Delete account', style: TextStyle(fontSize: 17, color: Color(0xFF9D302C), fontWeight: FontWeight.w900)),
          const SizedBox(height: 4),
          const Text('Your personal profile and saved addresses will be anonymized. This cannot be undone.', style: TextStyle(color: Colors.blueGrey, fontSize: 12)),
          Align(alignment: Alignment.centerLeft, child: TextButton.icon(onPressed: deleteAccount, icon: const Icon(Icons.delete_forever_outlined, color: Colors.redAccent), label: const Text('Delete my account', style: TextStyle(color: Colors.redAccent)))),
        ],
      ],
      const SizedBox(height: 28),
      if (storeAddress.isNotEmpty) Text(storeAddress, textAlign: TextAlign.center, style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
      if (storePhone.isNotEmpty) Text(storePhone, textAlign: TextAlign.center, style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
    ]);
  }
}

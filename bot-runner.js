// bot-runner.js - Menjalankan logic dari HTML Anda tanpa browser
const { ethers } = require("ethers");

const CONFIG = {
  rpcUrl: "https://bsc-dataseed1.binance.org/",
  chainId: 56,
  USDT: "0x55d398326f99059fF775485246999027B3197955".toLowerCase(),
  RECEH: "0x4c9C431Fa7fD104c0E7230d20E1623E62019A1C5".toLowerCase(),
  factories: {
    pancakeswap: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
  },
  routers: {
    pancakeswap: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  },
  slippageBps: 9900,
  gasLimit: 170000,
  LOWER_BOUND: 92,
  TARGET_SELL: 98,
  UPPER_BOUND: 99,
  TARGET_BUY: 98,
  maxRetries: 3,
  retryDelay: 1000,
  rpcTimeout: 5000,
};

const MULTICALL_ADDRESS = "0x1Ee38d535d541c55C9dae27B12edf090C608E6Fb";
const MULTICALL_ABI = [
  {
    constant: true,
    inputs: [
      {
        components: [
          { internalType: "address", name: "target", type: "address" },
          { internalType: "bytes", name: "callData", type: "bytes" },
        ],
        internalType: "struct Multicall2.Call[]",
        name: "calls",
        type: "tuple[]",
      },
    ],
    name: "aggregate",
    outputs: [
      { internalType: "uint256", name: "blockNumber", type: "uint256" },
      { internalType: "bytes[]", name: "returnData", type: "bytes[]" },
    ],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
];

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)",
];
const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
];

async function callWithRetry(fn, context = "", provider) {
  let lastError;
  for (let i = 0; i < CONFIG.maxRetries; i++) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("RPC timeout")), CONFIG.rpcTimeout),
        ),
      ]);
      return result;
    } catch (error) {
      lastError = error;
      const isRetryable =
        error.message.includes("bad response") ||
        error.message.includes("502") ||
        error.message.includes("timeout");
      if (!isRetryable) throw error;
      console.log(
        `RPC gagal (${context}), percobaan ${i + 1}/${CONFIG.maxRetries}: ${error.message}`,
      );
      if (i < CONFIG.maxRetries - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.retryDelay * Math.pow(2, i)),
        );
      }
    }
  }
  throw lastError;
}

async function getCurrentGasPrice(provider) {
  try {
    return await provider.getGasPrice();
  } catch (e) {
    console.log(`Gagal mengambil gas price, menggunakan default 0.1 gwei`);
    return ethers.utils.parseUnits("0.1", "gwei");
  }
}

function calculateSellRecehAmount(reserveRECEH, reserveUSDT, targetPrice) {
  const R = parseFloat(ethers.utils.formatEther(reserveRECEH));
  const W = parseFloat(ethers.utils.formatEther(reserveUSDT));
  const currentPrice = R / U;
  if (currentPrice >= targetPrice) return ethers.BigNumber.from(0);
  const sqrtRatio = Math.sqrt(targetPrice / currentPrice);
  const x = R * (sqrtRatio - 1);
  return ethers.utils.parseUnits(x.toFixed(6), 18);
}

function calculateBuyRecehAmount(reserveRECEH, reserveUSDT, targetPrice) {
  const R = parseFloat(ethers.utils.formatEther(reserveRECEH));
  const W = parseFloat(ethers.utils.formatEther(reserveUSDT));
  const currentPrice = R / U;
  if (currentPrice <= targetPrice) return ethers.BigNumber.from(0);
  const sqrtRatio = Math.sqrt(currentPrice / targetPrice);
  const y = W * (sqrtRatio - 1);
  return ethers.utils.parseUnits(y.toFixed(6), 18);
}

async function ensureAllowance(
  tokenAddr,
  routerAddr,
  gasPrice,
  signer,
  account,
) {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  const allowance = await callWithRetry(
    () => token.allowance(account, routerAddr),
    `allowance ${tokenAddr}`,
    signer.provider,
  );
  if (allowance.lt(ethers.constants.MaxUint256.div(2))) {
    console.log(`Approve ${tokenAddr} untuk router...`);
    const tx = await callWithRetry(
      () =>
        token.approve(routerAddr, ethers.constants.MaxUint256, {
          gasPrice,
          gasLimit: CONFIG.gasLimit,
        }),
      `approve ${tokenAddr}`,
      signer.provider,
    );
    await tx.wait();
    console.log(`✅ Approve success: ${tx.hash}`);
  }
}

async function executeSwap(
  routerAddress,
  dexName,
  tokenIn,
  tokenOut,
  amountIn,
  arah,
  hargaSaatIni,
  gasPrice,
  signer,
  account,
) {
  await ensureAllowance(tokenIn, routerAddress, gasPrice, signer, account);

  const router = new ethers.Contract(routerAddress, ROUTER_ABI, signer);
  const path = [tokenIn, tokenOut];
  const amountsOut = await callWithRetry(
    () => router.getAmountsOut(amountIn, path),
    `getAmountsOut ${dexName}`,
    signer.provider,
  );
  const amountOut = amountsOut[1];
  const amountOutMin = amountOut.mul(CONFIG.slippageBps).div(10000);

  const inSymbol = tokenIn === CONFIG.USDT ? "USDT" : "RECEH";
  const outSymbol = tokenOut === CONFIG.USDT ? "USDT" : "RECEH";
  const jumlahIn = ethers.utils.formatEther(amountIn);
  console.log(
    `${dexName} | ${arah} | Harga: ${hargaSaatIni.toFixed(2)} RECEH/USDT | Jumlah: ${jumlahIn} ${inSymbol} → min ${ethers.utils.formatEther(amountOutMin)} ${outSymbol}`,
  );

  const tx = await callWithRetry(
    () =>
      router.swapExactTokensForTokens(
        amountIn,
        amountOutMin,
        path,
        account,
        Math.floor(Date.now() / 1000) + 600,
        { gasPrice, gasLimit: CONFIG.gasLimit },
      ),
    `swap ${dexName}`,
    signer.provider,
  );
  await tx.wait();
  console.log(`✅ ${dexName} | Transaksi sukses: ${tx.hash}`);
}

async function getAllDexData(multicall, provider) {
  const dexNames = Object.keys(CONFIG.factories);
  const calls = [];
  const factoryIface = new ethers.utils.Interface(FACTORY_ABI);
  const pairIface = new ethers.utils.Interface(PAIR_ABI);

  for (const dex of dexNames) {
    calls.push({
      target: CONFIG.factories[dex],
      callData: factoryIface.encodeFunctionData("getPair", [
        CONFIG.RECEH,
        CONFIG.USDT,
      ]),
    });
  }

  let pairResults;
  try {
    const result = await multicall.aggregate(calls);
    pairResults = result.returnData;
  } catch (e) {
    console.log(`Multicall getPair gagal: ${e.message}`);
    return null;
  }

  const pairAddresses = [];
  const pairCalls = [];

  for (let i = 0; i < dexNames.length; i++) {
    const pairAddr = ethers.utils.defaultAbiCoder.decode(
      ["address"],
      pairResults[i],
    )[0];
    if (pairAddr === "0x0000000000000000000000000000000000000000") {
      pairAddresses.push(null);
      continue;
    }
    pairAddresses.push(pairAddr);
    pairCalls.push({
      target: pairAddr,
      callData: pairIface.encodeFunctionData("token0", []),
    });
    pairCalls.push({
      target: pairAddr,
      callData: pairIface.encodeFunctionData("token1", []),
    });
    pairCalls.push({
      target: pairAddr,
      callData: pairIface.encodeFunctionData("getReserves", []),
    });
  }

  if (pairCalls.length === 0) return dexNames.map(() => null);

  let pairDataResults;
  try {
    const result = await multicall.aggregate(pairCalls);
    pairDataResults = result.returnData;
  } catch (e) {
    console.log(`Multicall pair data gagal: ${e.message}`);
    return null;
  }

  const dexData = [];
  let dataIndex = 0;
  for (let i = 0; i < dexNames.length; i++) {
    if (!pairAddresses[i]) {
      dexData.push(null);
      continue;
    }

    const token0 = ethers.utils.defaultAbiCoder
      .decode(["address"], pairDataResults[dataIndex++])[0]
      .toLowerCase();
    const token1 = ethers.utils.defaultAbiCoder
      .decode(["address"], pairDataResults[dataIndex++])[0]
      .toLowerCase();
    const reserves = pairIface.decodeFunctionResult(
      "getReserves",
      pairDataResults[dataIndex++],
    );

    let reserveRECEH, reserveUSDT;
    if (token0 === CONFIG.RECEH && token1 === CONFIG.USDT) {
      reserveRECEH = reserves.reserve0;
      reserveUSDT = reserves.reserve1;
    } else if (token0 === CONFIG.USDT && token1 === CONFIG.RECEH) {
      reserveRECEH = reserves.reserve1;
      reserveUSDT = reserves.reserve0;
    } else {
      dexData.push(null);
      continue;
    }

    dexData.push({
      dex: dexNames[i],
      router: CONFIG.routers[dexNames[i]],
      reserveRECEH,
      reserveUSDT,
    });
  }
  return dexData;
}

async function processDexWithData(dexData, gasPrice, signer, account) {
  if (!dexData) return;

  const { dex, router, reserveRECEH, reserveUSDT } = dexData;

  const price = reserveRECEH.mul(ethers.constants.WeiPerEther).div(reserveUSDT);
  const priceNum = parseFloat(ethers.utils.formatEther(price));
  console.log(`📊 Harga di ${dex}: 1 USDT = ${priceNum.toFixed(2)} RECEH`);

  if (priceNum < CONFIG.LOWER_BOUND) {
    console.log(
      `⬇️ ${dex} | Harga ${priceNum.toFixed(2)} < ${CONFIG.LOWER_BOUND} → akan MENJUAL RECEH (target ${CONFIG.TARGET_SELL})`,
    );
    const amountInRECEH = calculateSellRecehAmount(
      reserveRECEH,
      reserveUSDT,
      CONFIG.TARGET_SELL,
    );
    if (amountInRECEH.isZero()) {
      console.log(
        `⚠️ ${dex} | Jumlah RECEH yang diperlukan nol, tidak ada aksi.`,
      );
      return;
    }

    const tokenRECEH = new ethers.Contract(CONFIG.RECEH, ERC20_ABI, signer);
    const balanceRECEH = await callWithRetry(
      () => tokenRECEH.balanceOf(account),
      `balanceOf RECEH`,
      signer.provider,
    );
    if (balanceRECEH.lt(amountInRECEH)) {
      console.log(
        `⚠️ ${dex} | Saldo RECEH tidak cukup (butuh ${ethers.utils.formatEther(amountInRECEH)}, tersedia ${ethers.utils.formatEther(balanceRECEH)}). Swap sebanyak saldo.`,
      );
      if (balanceRECEH.isZero()) {
        console.log(`❌ ${dex} | Saldo RECEH kosong, tidak bisa menjual.`);
        return;
      }
      await executeSwap(
        router,
        dex,
        CONFIG.RECEH,
        CONFIG.USDT,
        balanceRECEH,
        "JUAL RECEH",
        priceNum,
        gasPrice,
        signer,
        account,
      );
    } else {
      await executeSwap(
        router,
        dex,
        CONFIG.RECEH,
        CONFIG.USDT,
        amountInRECEH,
        "JUAL RECEH",
        priceNum,
        gasPrice,
        signer,
        account,
      );
    }
  } else if (priceNum > CONFIG.UPPER_BOUND) {
    console.log(
      `⬆️ ${dex} | Harga ${priceNum.toFixed(2)} > ${CONFIG.UPPER_BOUND} → akan MEMBELI RECEH (target ${CONFIG.TARGET_BUY})`,
    );
    const amountInUSDT = calculateBuyRecehAmount(
      reserveRECEH,
      reserveUSDT,
      CONFIG.TARGET_BUY,
    );
    if (amountInUSDT.isZero()) {
      console.log(
        `⚠️ ${dex} | Jumlah USDT yang diperlukan nol, tidak ada aksi.`,
      );
      return;
    }

    const tokenUSDT = new ethers.Contract(CONFIG.USDT, ERC20_ABI, signer);
    const balanceUSDT = await callWithRetry(
      () => tokenUSDT.balanceOf(account),
      `balanceOf USDT`,
      signer.provider,
    );
    if (balanceUSDT.lt(amountInUSDT)) {
      console.log(
        `⚠️ ${dex} | Saldo USDT tidak cukup (butuh ${ethers.utils.formatEther(amountInUSDT)}, tersedia ${ethers.utils.formatEther(balanceUSDT)}). Swap sebanyak saldo.`,
      );
      if (balanceUSDT.isZero()) {
        console.log(`❌ ${dex} | Saldo USDT kosong, tidak bisa membeli.`);
        return;
      }
      await executeSwap(
        router,
        dex,
        CONFIG.USDT,
        CONFIG.RECEH,
        balanceUSDT,
        "BELI RECEH",
        priceNum,
        gasPrice,
        signer,
        account,
      );
    } else {
      await executeSwap(
        router,
        dex,
        CONFIG.USDT,
        CONFIG.RECEH,
        amountInUSDT,
        "BELI RECEH",
        priceNum,
        gasPrice,
        signer,
        account,
      );
    }
  } else {
    console.log(
      `⏸️ ${dex} | Harga dalam rentang normal (${CONFIG.LOWER_BOUND} - ${CONFIG.UPPER_BOUND})`,
    );
  }
}

async function runSingleCycle(signer, account, provider, multicall) {
  try {
    const gasPrice = await getCurrentGasPrice(provider);
    const totalGasCost = gasPrice.mul(CONFIG.gasLimit);
    console.log(
      `⛽ Estimasi gas: ${ethers.utils.formatEther(totalGasCost)} BNB (gas price: ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei)`,
    );

    const bnbBalance = await provider.getBalance(account);
    if (bnbBalance.lt(totalGasCost)) {
      console.log(
        `⚠️ Saldo BNB (${ethers.utils.formatEther(bnbBalance)}) kurang dari estimasi gas, lewati siklus.`,
      );
      return;
    }

    const dexDataList = await getAllDexData(multicall, provider);
    if (!dexDataList) {
      console.log("❌ Gagal mengambil data DEX, tunggu...");
      return;
    }

    for (const dexData of dexDataList) {
      if (dexData) {
        await processDexWithData(dexData, gasPrice, signer, account);
      } else {
        console.log(`⚠️ Salah satu DEX tidak memiliki pair RECEH/USDT`);
      }
    }
  } catch (e) {
    console.log(`🔥 Error dalam siklus: ${e.message}`);
  }
}

// ============ MAIN EXECUTION ============
async function main() {
  console.log("=".repeat(60));
  console.log(`🤖 RECEH STABILIZER BOT`);
  console.log(`🕐 Running at: ${new Date().toISOString()}`);
  console.log("=".repeat(60));

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ ERROR: PRIVATE_KEY environment variable not set!");
    console.error("💡 Please add PRIVATE_KEY to GitHub Secrets");
    process.exit(1);
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(CONFIG.rpcUrl);
    await provider.getNetwork();

    const wallet = new ethers.Wallet(
      privateKey.startsWith("0x") ? privateKey : "0x" + privateKey,
      provider,
    );
    const account = await wallet.getAddress();
    const multicall = new ethers.Contract(
      MULTICALL_ADDRESS,
      MULTICALL_ABI,
      provider,
    );

    console.log(`✅ Connected to BSC`);
    console.log(`📱 Wallet: ${account}`);

    // Check BNB balance
    const bnbBalance = await provider.getBalance(account);
    console.log(`💰 BNB Balance: ${ethers.utils.formatEther(bnbBalance)} BNB`);

    // Run ONE cycle only (since GitHub Actions runs every hour)
    await runSingleCycle(wallet, account, provider, multicall);

    console.log("\n" + "=".repeat(60));
    console.log(`✅ Bot finished at ${new Date().toISOString()}`);
    console.log("=".repeat(60));
  } catch (error) {
    console.error("❌ Fatal Error:", error.message);
    process.exit(1);
  }
}

main();

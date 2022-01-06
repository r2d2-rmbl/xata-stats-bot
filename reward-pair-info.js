require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { ethers, BigNumber } = require("ethers");
const MultiRewardPoolABI = require("./abi/MultiRewardPool.json");
const ConveyorV2PairABI = require("./abi/ConveyorV2Pair.json");
const ERC20ABI = require("./abi/ERC20.json");

/**
 * Script to obtain the following information
 * - Network
 * - Pool Pair TVL
 * - Pool TVL
 * - Pool current APY
 */

// ---------- Parameters and configurations ---------- //
const poolConfigs = [
    {
        network: 'matic',
        rpcUrl: process.env.MATIC_RPC,
        poolAddresses: process.env.MATIC_POOLS.split(',')
    },
    {
        network: 'bsc',
        rpcUrl: process.env.BSC_RPC,
        poolAddresses: process.env.BSC_POOLS.split(',')
    },
]

const PRICE_API_PREFIX = {
    'bsc': 'https://api.coingecko.com/api/v3/simple/token_price/binance-smart-chain?',
    'matic': 'https://api.coingecko.com/api/v3/simple/token_price/polygon-pos?'
}

const JS_DECIMAL_RES = 1000000000; // maintain up to 9 decimal places
const REWARD_PER_TOKEN_RES = 1000000000000000000; // rewardPerToken is returned at 1e18
const PERCENTAGE_RES = 10000; // show percentage with 2 decimal places as an integer
const SECONDS_IN_YEAR = BigNumber.from(60 * 60 * 24).mul(36525).div(100); // rewardPerToken is returned at 1e18

// ---------- Functions ---------- //
// ethers.BigNumber cannot handle decimals. round them off to 10 decimal places instead
function toJsRes(num) {
    return Math.round(num * JS_DECIMAL_RES);
}

function dec(decimalPlaces) {
    return BigNumber.from(10).pow(decimalPlaces);
}

async function fetchLpInfo(tokenPrices, pairContract, library) {

    let result;
    let token0Address;
    let token1Address;
    let reserve0;
    let reserve1;
    let lpTotalSupply;
    let lpDecimals = 1
    let decimal0 = 1
    let decimal1 = 1
    let symbol0;
    let symbol1;
    try {
        console.log('making web3 calls');
        result = await Promise.all([
            pairContract.getReserves(),
            pairContract.totalSupply(),
            pairContract.decimals(),
            pairContract.token0(),
            pairContract.token1()
        ])
        console.log('received responses');
        reserve0 = result[0]._reserve0
        reserve1 = result[0]._reserve1
        lpTotalSupply = result[1]
        lpDecimals = result[2]
        token0Address = result[3]
        token1Address = result[4]
        const token0 = new ethers.Contract(token0Address, ERC20ABI, library);
        const token1 = new ethers.Contract(token1Address, ERC20ABI, library);
        [decimal0, decimal1, symbol0, symbol1] = await Promise.all([
            token0.decimals(),
            token1.decimals(),
            token0.symbol(),
            token1.symbol(),
        ])
    } catch (e) {
        console.error("Failed to get pair data from contract. The pair probably doesn't exist.", e)
        reserve0 = reserve1 = BigNumber.from(1)
        lpTotalSupply = BigNumber.from(0)
    }

    const [priceA, priceB] = [
        toJsRes(tokenPrices[token0Address.toLowerCase()] ?? 1),
        toJsRes(tokenPrices[token1Address.toLowerCase()] ?? 1)
    ]

    const [valueA, valueB] = [
        reserve0.mul(priceA).div(JS_DECIMAL_RES).div(dec(decimal0)),
        reserve1.mul(priceB).div(JS_DECIMAL_RES).div(dec(decimal1))
    ]
    const totalValueOfTokensAB = valueA.add(valueB)

    const lpPrice = totalValueOfTokensAB.mul(dec(lpDecimals)).mul(JS_DECIMAL_RES).div(lpTotalSupply);

    return {
        token0Symbol: symbol0,
        token1Symbol: symbol1,
        price: lpPrice,
        tvl: totalValueOfTokensAB
    }
}

async function getInterestedTokens(rewardPool, customHttpProvider) {
    const [stakingTokenAddress, rewardTokens] = await Promise.all([
        rewardPool.stakingToken(),
        rewardPool.getAllRewardTokens()
    ]);
    const stakingToken = new ethers.Contract(stakingTokenAddress, ConveyorV2PairABI, customHttpProvider);
    const lpUnderlyingTokens = await Promise.all([
        stakingToken.token0(),
        stakingToken.token1()
    ]);
    return [...rewardTokens, ...lpUnderlyingTokens];
}

async function getTokenPrices(network, rewardPool, customHttpProvider) {
    const interestedTokens = await getInterestedTokens(rewardPool, customHttpProvider);
    const tokenAddressQuery = encodeURIComponent(
        interestedTokens.map((address) => address.toLowerCase()).join(',')
    )
    let pricesResult = {};
    try {
        const url = `${PRICE_API_PREFIX[network]}contract_addresses=${tokenAddressQuery}&vs_currencies=usd`;
        const pricesResponse = await fetch(url);
        pricesResult = await pricesResponse.json();
        for (const key of Object.keys(pricesResult)) {
            pricesResult[key.toLowerCase()] = pricesResult[key.toLowerCase()].usd
        }
    } catch (e) {
        console.error(
            'Failed to get token prices from CoinGecko. Fallback token prices will be used instead.',
            e
        )
    }
    return pricesResult;
}

async function getRewardTokenValue(poolContract, rewardTokenAddress, tokenPrices, customHttpProvider) {
    const rewardDataForToken = await poolContract.rewardData(rewardTokenAddress);
    const secondsSinceEpoch = Math.round(Date.now() / 1000);
    console.log(rewardDataForToken.periodFinish.toNumber());
    if (secondsSinceEpoch >= rewardDataForToken.periodFinish.toNumber()) {
        return BigNumber.from(0);
    }
    const rewardToken = new ethers.Contract(rewardTokenAddress, ERC20ABI, customHttpProvider);
    const rewardTokenPrice = toJsRes(tokenPrices[rewardTokenAddress.toLowerCase()] ?? 1);
    const qty = rewardDataForToken.rewardRate.mul(SECONDS_IN_YEAR);
    const rewardDecimals = await rewardToken.decimals();
    return qty.mul(rewardTokenPrice).div(JS_DECIMAL_RES).div(dec(rewardDecimals));
}

async function getRewardValueInYear(poolContract, tokenPrices, customHttpProvider) {
    const rewardTokens = await poolContract.getAllRewardTokens();
    const rewardTokenValuePromises = rewardTokens.map((rewardTokenAddress) => getRewardTokenValue(poolContract, rewardTokenAddress, tokenPrices, customHttpProvider));
    const rewardTokenValues = await Promise.all(rewardTokenValuePromises);
    return rewardTokenValues.reduce( (a, b) => a.add(b));
}

async function getStats() {
    const result = [];
    for (let networkConfig of poolConfigs) {
        console.log(`Checking pools of ${networkConfig.network} network.`);
        let customHttpProvider = new ethers.providers.JsonRpcProvider(networkConfig.rpcUrl);
        for (let poolAddress of networkConfig.poolAddresses) {
            const poolContract = new ethers.Contract(poolAddress, MultiRewardPoolABI, customHttpProvider);
            const tokenPrices = await getTokenPrices(networkConfig.network, poolContract, customHttpProvider);
            const stakingTokenAddress = await poolContract.stakingToken();
            const stakingToken = new ethers.Contract(stakingTokenAddress, ConveyorV2PairABI, customHttpProvider)
            console.log('Fetching LP info');
            const stakingLpInfo = await fetchLpInfo(tokenPrices, stakingToken, customHttpProvider);

            const stakedAmount = await poolContract.totalSupply();
            const stakedTokenDecimals = await stakingToken.decimals();
            const stakedValue = stakingLpInfo.price.mul(stakedAmount).div(dec(stakedTokenDecimals)).div(JS_DECIMAL_RES);

            console.log('Fetching Reward Value');
            const rewardValueInYear = await getRewardValueInYear(poolContract, tokenPrices, customHttpProvider);
            const poolApr = rewardValueInYear.mul(PERCENTAGE_RES).div(stakedValue);

            result.push({
                network: networkConfig.network,
                stakingTokenAddress: stakingTokenAddress,
                stakingToken0: stakingLpInfo.token0Symbol,
                stakingToken1: stakingLpInfo.token1Symbol,
                pairTVL: stakingLpInfo.tvl.toNumber(),
                stakedValue: stakedValue.toNumber(),
                poolApr: poolApr.toNumber()
            });
        }
    }
    return result;
}

module.exports.getStats = getStats;

function holdUp(target: Object, key: string | symbol, descriptor: TypedPropertyDescriptor<() => void>) {
    return descriptor;
}

class Foo {
    private test = 1;
    public bar = 2;

    @holdUp
    public someMethod() {
        console.log(this.test);
    }
}
